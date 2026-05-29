# Order Service — API Documentation

> **Base URL:** `http://localhost:5503`  
> **Postman Collection:** [`Order-Service.postman_collection.json`](./Order-Service.postman_collection.json)

## Overview

The Order Service handles the complete ordering lifecycle: placing orders, payment processing via Stripe, coupon management, customer profile management, and real-time order status updates via Kafka.

### Authentication Mechanism

All endpoints require an `accessToken` **httpOnly cookie** set by the auth-service after login.

### Roles

| Role | Access |
|---|---|
| `admin` | View all orders across all tenants, change order status |
| `manager` | View orders for their own tenant only, change order status |
| `customer` | Place orders, view own orders |

### Key Concepts

| Concept | Description |
|---|---|
| **Idempotency Key** | A unique UUID sent as a header with `POST /orders` to prevent duplicate orders on network retry |
| **Payment Mode** | `card` (Stripe checkout) or `cash` (no payment gateway) |
| **Pricing Cache** | Order service maintains a local cache of product and topping prices synced from catalog service via Kafka. Prices in the cart are ignored — server uses only cached prices. |
| **Tax** | 18% GST applied server-side |
| **Delivery** | ₹100 flat delivery charge applied server-side |

---

## 🛒 Order Endpoints

Base path: `/orders`

---

### `POST /orders`

Place a new order.

**Auth required:** `accessToken` cookie (any authenticated role)

**Headers:**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | ✅ | `application/json` |
| `Idempotency-Key` | ✅ | A unique UUID per order attempt. Same key on retry returns the same order without creating a duplicate. |

**Request Body** (`application/json`):

```json
{
  "cart": [
    {
      "_id": "65f1a2b3c4d5e6f7a8b9c0d2",
      "name": "Margherita Pizza",
      "image": "https://example.com/image.jpg",
      "qty": 2,
      "chosenConfiguration": {
        "priceConfiguration": {
          "Size": "Medium",
          "Crust": "Thin"
        },
        "selectedToppings": [
          {
            "id": "65f1a2b3c4d5e6f7a8b9c0d3",
            "name": "Extra Cheese",
            "price": 49
          }
        ]
      }
    }
  ],
  "customerId": "65f1a2b3c4d5e6f7a8b9c0d5",
  "tenantId": "1",
  "paymentMode": "card",
  "couponCode": "NEWYEAR2025",
  "address": "123 Main Street, Mumbai",
  "comment": "Extra spicy please"
}
```

**Top-level fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `cart` | array | ✅ | Array of cart items |
| `customerId` | string | ✅ | MongoDB ObjectId of the customer document |
| `tenantId` | string | ✅ | Restaurant ID |
| `paymentMode` | string | ✅ | `"card"` or `"cash"` |
| `couponCode` | string | ❌ | Optional discount coupon code |
| `address` | string | ✅ | Delivery address |
| `comment` | string | ❌ | Optional order note |

**Cart item structure:**

| Field | Type | Description |
|---|---|---|
| `_id` | string | Product MongoDB ObjectId |
| `name` | string | Product name (display only) |
| `image` | string | Image URL (display only) |
| `qty` | number | Quantity |
| `chosenConfiguration.priceConfiguration` | object | Map of dimension → selected option (e.g., `{ "Size": "Medium" }`) |
| `chosenConfiguration.selectedToppings` | array | Selected toppings with `id`, `name`, `price` |

**Server-side pricing logic:**

```
itemPrice = productBasePrice (from cache) + toppingPrices (from cache)
totalPrice = sum of (qty × itemPrice) for each cart item
discountAmount = totalPrice × discountPercentage / 100   (if valid coupon)
priceAfterDiscount = totalPrice - discountAmount
taxes = priceAfterDiscount × 18%
finalTotal = priceAfterDiscount + taxes + ₹100 (delivery)
```

> ⚠️ Prices from the cart body are ignored. Only the server-side cache prices are used.

**Response — `200 OK` (card payment):**

```json
{ "paymentUrl": "https://checkout.stripe.com/c/pay/cs_test_xxxxxxxxxxxx" }
```

Redirect the user to this URL to complete payment on Stripe's hosted page.

**Response — `200 OK` (cash payment):**

```json
{ "paymentUrl": null }
```

**Side effect:** Publishes an `ORDER_CREATE` event to the `order` Kafka topic (consumed by notification-service and ws-service).

---

### `GET /orders`

Retrieve all orders (admin/manager only).

**Auth required:** `accessToken` cookie — `admin` or `manager` role

> Customers attempting this endpoint receive `403 Forbidden`.

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tenantId` | string | (Admin only) Filter by restaurant. Managers always see only their own tenant's orders. |

**Example Request:**
```
GET /orders?tenantId=1
```

**Behavior by role:**

| Role | Behavior |
|---|---|
| `admin` | Returns all orders (optionally filtered by `tenantId`) |
| `manager` | Returns only orders from their own restaurant (query param ignored) |
| `customer` | `403 Forbidden` |

**Response — `200 OK`:**

```json
[
  {
    "_id": "65f1a2b3c4d5e6f7a8b9c0d4",
    "cart": [ ... ],
    "address": "123 Main Street, Mumbai",
    "comment": "Extra spicy please",
    "customerId": {
      "_id": "65f1a2b3c4d5e6f7a8b9c0d5",
      "firstName": "Swarup",
      "lastName": "Das",
      "email": "swarup@example.com"
    },
    "tenantId": "1",
    "total": 584,
    "discount": 0,
    "taxes": 84,
    "deliveryCharges": 100,
    "paymentMode": "card",
    "orderStatus": "received",
    "paymentStatus": "pending",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

> Results are sorted by `createdAt` descending (newest first). `customerId` is populated with the full customer document.

---

### `GET /orders/mine`

Retrieve all orders placed by the currently authenticated customer.

**Auth required:** `accessToken` cookie (customer)

**Query Parameters:** None

**Behavior:** Looks up the customer by `userId` from the JWT, then returns all their orders. The `cart` field is excluded from results.

**Response — `200 OK`:**

```json
[
  {
    "_id": "65f1a2b3c4d5e6f7a8b9c0d4",
    "address": "123 Main Street, Mumbai",
    "tenantId": "1",
    "total": 584,
    "discount": 0,
    "taxes": 84,
    "deliveryCharges": 100,
    "paymentMode": "card",
    "orderStatus": "received",
    "paymentStatus": "pending",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
]
```

**Response — `400 Bad Request`:**

```json
{
  "errors": [{ "type": "HttpError", "message": "No customer found." }]
}
```

---

### `GET /orders/:orderId`

Retrieve a single order by its MongoDB ObjectId.

**Auth required:** `accessToken` cookie

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `orderId` | string | MongoDB ObjectId of the order |

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `fields` | string | Comma-separated list of fields to include in the response (e.g., `orderStatus,paymentStatus,address`). `customerId` is always included. |

**Example Request:**
```
GET /orders/65f1a2b3c4d5e6f7a8b9c0d4?fields=orderStatus,paymentStatus,address
```

**Access control:**

| Role | Access |
|---|---|
| `admin` | Any order |
| `manager` | Only orders from their own restaurant |
| `customer` | Only their own orders (matched by customer document) |

**Response — `200 OK`:**

```json
{
  "_id": "65f1a2b3c4d5e6f7a8b9c0d4",
  "orderStatus": "received",
  "paymentStatus": "pending",
  "address": "123 Main Street, Mumbai",
  "customerId": {
    "_id": "65f1a2b3c4d5e6f7a8b9c0d5",
    "firstName": "Swarup"
  }
}
```

**Response — `400 Bad Request`:**

```json
{
  "errors": [{ "type": "HttpError", "message": "Order does not exists." }]
}
```

---

### `PATCH /orders/change-status/:orderId`

Update the status of an order.

**Auth required:** `accessToken` cookie — `admin` or `manager` role

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `orderId` | string | MongoDB ObjectId of the order |

**Request Body** (`application/json`):

```json
{ "status": "preparing" }
```

**Valid `orderStatus` values:**

| Status | Description |
|---|---|
| `received` | Order placed, awaiting confirmation |
| `confirmed` | Restaurant confirmed the order |
| `preparing` | Order is being prepared |
| `out_for_delivery` | Order dispatched for delivery |
| `delivered` | Order delivered to customer |

**Access control:**

| Role | Access |
|---|---|
| `admin` | Can update any order |
| `manager` | Can only update orders from their own restaurant |

**Response — `200 OK`:**

```json
{ "_id": "65f1a2b3c4d5e6f7a8b9c0d4" }
```

**Side effect:** Publishes an `ORDER_STATUS_UPDATE` event to the `order` Kafka topic.

**Response — `403 Forbidden`:**

```json
{
  "errors": [{ "type": "HttpError", "message": "Not allowed." }]
}
```

---

## 🎟️ Coupon Endpoints

Base path: `/coupons`

---

### `POST /coupons`

Create a new discount coupon for a restaurant.

**Auth required:** `accessToken` cookie

**Request Body** (`application/json`):

```json
{
  "title": "New Year Offer",
  "code": "NEWYEAR2025",
  "discount": 20,
  "validUpto": "2025-12-31T23:59:59.000Z",
  "tenantId": "1"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Display name for the coupon |
| `code` | string | ✅ | Unique coupon code (case-sensitive) |
| `discount` | number | ✅ | Percentage discount (e.g., `20` = 20%) |
| `validUpto` | string | ✅ | ISO 8601 expiry datetime |
| `tenantId` | string | ✅ | Restaurant this coupon belongs to |

**Response — `200 OK`:**

```json
{
  "_id": "65f1a2b3c4d5e6f7a8b9c0d6",
  "title": "New Year Offer",
  "code": "NEWYEAR2025",
  "discount": 20,
  "validUpto": "2025-12-31T23:59:59.000Z",
  "tenantId": "1",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

---

### `POST /coupons/verify`

Check if a coupon code is valid and not expired.

**Auth required:** `accessToken` cookie

**Request Body** (`application/json`):

```json
{
  "code": "NEWYEAR2025",
  "tenantId": "1"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✅ | Coupon code to verify |
| `tenantId` | string | ✅ | Restaurant ID the coupon belongs to |

**Response — `200 OK` (valid coupon):**

```json
{ "valid": true, "discount": 20 }
```

**Response — `200 OK` (expired coupon):**

```json
{ "valid": false, "discount": 0 }
```

**Response — `400 Bad Request` (coupon not found):**

```json
{
  "errors": [{ "type": "HttpError", "message": "Coupon does not exists" }]
}
```

---

## 👤 Customer Endpoints

Base path: `/customer`

The customer document stores the user's delivery addresses and is linked to the auth-service user via `userId`.

---

### `GET /customer`

Retrieve the customer profile for the currently authenticated user. If no profile exists, one is auto-created from the JWT claims (`firstName`, `lastName`, `email`).

**Auth required:** `accessToken` cookie

**Response — `200 OK`:**

```json
{
  "_id": "65f1a2b3c4d5e6f7a8b9c0d5",
  "userId": "42",
  "firstName": "Swarup",
  "lastName": "Das",
  "email": "swarup@example.com",
  "addresses": [
    {
      "text": "123 Main Street, Mumbai",
      "isDefault": false
    }
  ],
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

---

### `PATCH /customer/addresses/:id`

Add a new delivery address to a customer's profile.

**Auth required:** `accessToken` cookie

> **Ownership check:** The customer document's `userId` is validated against the `sub` claim from the JWT, ensuring users can only modify their own profile.

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | MongoDB ObjectId of the customer document (from `GET /customer`) |

**Request Body** (`application/json`):

```json
{
  "address": "456 Park Avenue, Delhi 110001"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✅ | Full delivery address string |

**Response — `200 OK`:**

```json
{
  "_id": "65f1a2b3c4d5e6f7a8b9c0d5",
  "userId": "42",
  "firstName": "Swarup",
  "lastName": "Das",
  "email": "swarup@example.com",
  "addresses": [
    { "text": "123 Main Street, Mumbai", "isDefault": false },
    { "text": "456 Park Avenue, Delhi 110001", "isDefault": false }
  ]
}
```

---

## 💳 Payment Endpoints

Base path: `/payments`

> ⚠️ This endpoint is called by **Stripe**, not your frontend. For local testing, use the [Stripe CLI](https://stripe.com/docs/stripe-cli):
> ```bash
> stripe listen --forward-to localhost:5503/payments/webhook
> ```

---

### `POST /payments/webhook`

Handle incoming Stripe webhook events for payment completion.

**Caller:** Stripe (not the frontend)

**Headers set by Stripe:**

| Header | Description |
|---|---|
| `stripe-signature` | Stripe's HMAC signature for payload verification |

**Request Body** (raw JSON from Stripe):

```json
{
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_xxxxxxxxxxxx"
    }
  }
}
```

**Supported event types:**

| Event | Action |
|---|---|
| `checkout.session.completed` | Verifies session, updates order `paymentStatus` to `paid` or `failed` |

**Behavior:**
1. Receives the Stripe webhook payload
2. Retrieves the session from Stripe API to verify payment status
3. Updates the order's `paymentStatus` to `paid` (if `paymentStatus === "paid"`) or `failed`
4. Publishes a `PAYMENT_STATUS_UPDATE` event to the `order` Kafka topic

**Response — `200 OK`:**

```json
{ "success": true }
```

---

## 📋 Endpoint Summary

| Method | Endpoint | Auth | Role |
|---|---|---|---|
| `POST` | `/orders` | ✅ Cookie | Any |
| `GET` | `/orders` | ✅ Cookie | Admin / Manager |
| `GET` | `/orders/mine` | ✅ Cookie | Any |
| `GET` | `/orders/:orderId` | ✅ Cookie | Any (access-controlled) |
| `PATCH` | `/orders/change-status/:orderId` | ✅ Cookie | Admin / Manager |
| `POST` | `/coupons` | ✅ Cookie | Any |
| `POST` | `/coupons/verify` | ✅ Cookie | Any |
| `GET` | `/customer` | ✅ Cookie | Any |
| `PATCH` | `/customer/addresses/:id` | ✅ Cookie | Any (own only) |
| `POST` | `/payments/webhook` | Stripe only | — |

---

## ⚙️ Error Response Format

```json
{
  "errors": [
    {
      "type": "HttpError | UnauthorizedError | ForbiddenError",
      "message": "Human-readable error message"
    }
  ]
}
```

| Status | Meaning |
|---|---|
| `400` | Bad input, missing data, or resource not found |
| `401` | Missing or expired `accessToken` cookie |
| `403` | Authenticated but insufficient role |
| `500` | Internal server error |

---

## 🔗 Kafka Events

### Published

| Event | Topic | Trigger |
|---|---|---|
| `ORDER_CREATE` | `order` | New order placed |
| `ORDER_STATUS_UPDATE` | `order` | Order status changed |
| `PAYMENT_STATUS_UPDATE` | `order` | Stripe payment completed/failed |

### Consumed (from Catalog Service)

| Event | Topic | Action |
|---|---|---|
| `PRODUCT_CREATE` | `product` | Cache new product pricing |
| `PRODUCT_UPDATE` | `product` | Update product pricing cache |
| `TOPPING_CREATE` | `topping` | Cache new topping pricing |

---

## 🗺️ Order Status Flow

```
received → confirmed → preparing → out_for_delivery → delivered
```

## 💳 Payment Status Flow

```
pending → paid | failed
```
