# FocusBro Cloudflare Workers API Documentation

## Overview

The FocusBro API is built on Cloudflare Workers, leveraging D1 for persistent storage and KV for caching. It provides authentication, multi-device sync, and data management capabilities.

**Base URL:** `https://api.focusbro.io`

---

## Authentication

All endpoints (except auth endpoints) require Bearer token authentication.

```
Authorization: Bearer {token}
```

Tokens are valid for 30 days. After expiration, users must re-authenticate.

---

## API Endpoints

### Authentication Endpoints

#### Register
**POST** `/auth/register`

Create a new user account.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response (201):**
```json
{
  "success": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "token": "eyJhbGc...",
  "session_id": "550e8400-e29b-41d4-a716-446655440001"
}
```

**Validation:**
- Email must be valid format
- Password must be at least 8 characters
- Email must be unique (409 if already exists)

---

#### Login
**POST** `/auth/login`

Authenticate user and create session.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "token": "eyJhbGc...",
  "session_id": "550e8400-e29b-41d4-a716-446655440001",
  "device_id": "550e8400-e29b-41d4-a716-446655440002"
}
```

**Error (401):** Invalid email or password

---

#### Request Password Reset
**POST** `/auth/request-password-reset`

Initiate password reset flow.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "If this email is registered, password reset instructions have been sent."
}
```

**Rate Limit:** 3 requests per hour per email

---

#### Confirm Password Reset
**POST** `/auth/confirm-password-reset`

Complete password reset with token.

**Request:**
```json
{
  "resetToken": "550e8400-e29b-41d4-a716-446655440000",
  "newPassword": "NewSecurePass123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Password has been reset. Please log in with your new password."
}
```

**Requires:**
- Valid reset token (30 min expiry)
- Password min 8 characters

---

#### Logout All Devices
**POST** `/auth/logout-all`

Invalidate all active sessions.

**Headers:**
```
Authorization: Bearer {token}
```

**Response (200):**
```json
{
  "success": true,
  "message": "All sessions have been logged out"
}
```

---

### User Profile Endpoints

#### Get Profile
**GET** `/users/profile`

Retrieve authenticated user's profile information.

**Headers:**
```
Authorization: Bearer {token}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "avatarUrl": "https://example.com/avatar.jpg",
    "subscriptionTier": "pro",
    "deviceCount": 3,
    "createdAt": "2024-01-15T10:30:00Z",
    "lastLogin": "2024-01-20T14:22:00Z"
  }
}
```

---

#### Update Profile
**PUT** `/users/profile`

Update user profile information.

**Request:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "avatarUrl": "https://example.com/new-avatar.jpg"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "message": "Profile updated successfully"
  }
}
```

**Validation:**
- firstName: max 100 characters
- lastName: max 100 characters
- avatarUrl: must be valid HTTP(S) URL

---

#### Change Password
**POST** `/users/change-password`

Change user password.

**Request:**
```json
{
  "currentPassword": "OldPass123!",
  "newPassword": "NewPass123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "message": "Password changed successfully. All other sessions have been logged out."
  }
}
```

**Error (401):** Current password is incorrect

---

### Device Management Endpoints

#### List Devices
**GET** `/devices`

Get all active devices for authenticated user.

**Headers:**
```
Authorization: Bearer {token}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "devices": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "device_id": "device-uuid-1",
        "device_name": "MacBook Pro",
        "created_at": "2024-01-15T10:30:00Z",
        "last_activity": "2024-01-20T14:22:00Z"
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440002",
        "device_id": "device-uuid-2",
        "device_name": "iPhone 14",
        "created_at": "2024-01-16T08:15:00Z",
        "last_activity": "2024-01-20T09:45:00Z"
      }
    ]
  }
}
```

---

#### Remove Device
**DELETE** `/devices/{deviceId}`

Remove a device and invalidate its session.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "message": "Device removed successfully"
  }
}
```

**Error (404):** Device not found or unauthorized

---

### Data Sync Endpoints

#### Sync Data (Upload)
**POST** `/sync/data`

Upload user data from device for synchronization.

**Headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request:**
```json
{
  "data": {
    "tasks": [...],
    "settings": {...},
    "notes": [{...}, ...]
  },
  "device_id": "device-uuid-1"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "synced_at": "2024-01-20T14:22:00Z",
    "size_bytes": 2048
  }
}
```

**Rate Limit:** 100 requests per minute

---

#### Fetch Data (Download)
**GET** `/sync/data`

Download user data for device synchronization.

**Headers:**
```
Authorization: Bearer {token}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "data": {
      "tasks": [...],
      "settings": {...},
      "notes": [{...}, ...]
    },
    "source": "cache"
  }
}
```

**Sources:**
- `cache`: Retrieved from KV (faster)
- `database`: Retrieved from D1 (persistent)

---

### Account Endpoints

#### Delete Account
**POST** `/users/delete-account`

Permanently delete user account and all associated data.

**Request:**
```json
{
  "password": "UserPassword123!",
  "confirmation": "DELETE"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "message": "Account has been deleted"
  }
}
```

**Requirements:**
- Correct password verification
- Confirmation string must be "DELETE"
- All sessions invalidated

---

### Health & Status

#### Health Check
**GET** `/health`

Check API health status.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2024-01-20T14:22:00Z",
    "version": "1.0.0"
  }
}
```

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error message",
  "timestamp": "2024-01-20T14:22:00Z",
  "details": {}
}
```

### Common Error Codes

| Code | Meaning |
|------|---------|
| 400  | Bad Request - Invalid input |
| 401  | Unauthorized - Auth failed or expired |
| 404  | Not Found - Resource doesn't exist |
| 409  | Conflict - Resource already exists |
| 429  | Too Many Requests - Rate limit exceeded |
| 500  | Internal Server Error |

---

## Rate Limiting

Rate limits are enforced per user/endpoint:

| Endpoint | Limit |
|----------|-------|
| Most endpoints | 100 requests/minute |
| Password reset | 3 requests/hour |
| Sync endpoints | 100 requests/minute |

Rate limit info is included in response headers:
```
X-RateLimit-Remaining: 95
X-RateLimit-Reset-After: 60
```

---

## Security

### Password Requirements
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 number
- At least 1 special character

### Token Security
- Tokens expire after 30 days
- Changing password invalidates all sessions
- Each device gets unique session
- HTTPS required in production

### Data Encryption
- All data in transit: TLS 1.3+
- Passwords: SHA-256 hashed
- Sensitive data: Optional encryption available

---

## Webhooks (Future)

Planned webhook events:
- `account.created`
- `account.deleted`
- `device.disconnected`
- `data.synced`
- `security.alert`

---

## SDK/Client Libraries

Recommended clients:
- **JavaScript/TypeScript:** `focusbro-sdk-js`
- **Python:** `focusbro-sdk-py`
- **Go:** `focusbro-sdk-go`
- **Mobile:** Native implementations

---

## Changelog

### v1.0.0 (2024-01-20)
- Initial API release
- Authentication & session management
- User profile management
- Device management
- Data sync endpoints
- Password reset flow

---

## Support

For API issues or questions:
- Email: `api-support@focusbro.io`
- GitHub Issues: `github.com/focusbro/api`
- Documentation: `docs.focusbro.io`

