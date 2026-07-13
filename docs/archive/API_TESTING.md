# FocusBro API Testing Guide

A complete guide to testing the FocusBro API with example requests and responses.

---

## Quick Start

### 1. Start Development Server

```bash
cd focusbro/api
npm install
wrangler dev
```

API runs at `http://localhost:8787`

### 2. Test Health Endpoint

```bash
curl http://localhost:8787/health
```

Expected response:
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

## Authentication Test Cases

### Test 1: Register New User

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "TestPass123!"
  }'
```

**Expected (201):**
```json
{
  "success": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "testuser@example.com",
  "token": "eyJhbGc...",
  "session_id": "550e8400-e29b-41d4-a716-446655440001"
}
```

**Save token for next requests:**
```bash
export TOKEN="eyJhbGc..."
```

---

### Test 2: Login

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "TestPass123!"
  }'
```

**Expected (200):**
```json
{
  "success": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "testuser@example.com",
  "token": "eyJhbGc...",
  "session_id": "550e8400-e29b-41d4-a716-446655440001",
  "device_id": "550e8400-e29b-41d4-a716-446655440002"
}
```

---

### Test 3: Invalid Login

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "WrongPassword"
  }'
```

**Expected (401):**
```json
{
  "success": false,
  "error": "Invalid email or password",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

### Test 4: Register with Weak Password

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "weak"
  }'
```

**Expected (400):**
```json
{
  "success": false,
  "error": "Password must be at least 8 characters",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

### Test 5: Duplicate Email

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "AnotherPass123!"
  }'
```

**Expected (409):**
```json
{
  "success": false,
  "error": "Email already registered",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

## User Profile Tests

### Test 6: Get Profile

```bash
curl -X GET http://localhost:8787/users/profile \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "testuser@example.com",
    "firstName": null,
    "lastName": null,
    "avatarUrl": null,
    "subscriptionTier": "free",
    "deviceCount": 1,
    "createdAt": "2024-01-20T14:22:00Z",
    "lastLogin": "2024-01-20T14:22:00Z"
  }
}
```

---

### Test 7: Get Profile (No Auth)

```bash
curl -X GET http://localhost:8787/users/profile
```

**Expected (401):**
```json
{
  "success": false,
  "error": "Missing or invalid Authorization header",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

### Test 8: Update Profile

```bash
curl -X PUT http://localhost:8787/users/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "avatarUrl": "https://example.com/avatar.jpg"
  }'
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "message": "Profile updated successfully"
  }
}
```

---

### Test 9: Verify Profile Updated

```bash
curl -X GET http://localhost:8787/users/profile \
  -H "Authorization: Bearer $TOKEN"
```

Now shows:
```json
{
  "success": true,
  "data": {
    "firstName": "Test",
    "lastName": "User",
    "avatarUrl": "https://example.com/avatar.jpg"
  }
}
```

---

## Data Sync Tests

### Test 10: Upload Data

```bash
curl -X POST http://localhost:8787/sync/data \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "tasks": [
        {"id": 1, "title": "Task 1", "completed": false},
        {"id": 2, "title": "Task 2", "completed": true}
      ],
      "settings": {
        "theme": "dark",
        "language": "en"
      }
    },
    "device_id": "device-uuid-123"
  }'
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "synced_at": "2024-01-20T14:22:00Z",
    "size_bytes": 156
  }
}
```

---

### Test 11: Download Data

```bash
curl -X GET http://localhost:8787/sync/data \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "data": {
      "tasks": [
        {"id": 1, "title": "Task 1", "completed": false},
        {"id": 2, "title": "Task 2", "completed": true}
      ],
      "settings": {
        "theme": "dark",
        "language": "en"
      }
    },
    "source": "cache"
  }
}
```

---

## Device Management Tests

### Test 12: List Devices

```bash
curl -X GET http://localhost:8787/devices \
  -H "Authorization: Bearer $TOKEN"
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "devices": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "device_id": "device-uuid-1",
        "device_name": "My Laptop",
        "created_at": "2024-01-20T14:22:00Z",
        "last_activity": "2024-01-20T14:22:00Z"
      }
    ]
  }
}
```

---

## Password Management Tests

### Test 13: Change Password

```bash
curl -X POST http://localhost:8787/users/change-password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "currentPassword": "TestPass123!",
    "newPassword": "NewPass456!"
  }'
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "message": "Password changed successfully. All other sessions have been logged out."
  }
}
```

---

### Test 14: Change Password (Wrong Current Password)

```bash
curl -X POST http://localhost:8787/users/change-password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "currentPassword": "WrongPassword",
    "newPassword": "NewPass456!"
  }'
```

**Expected (401):**
```json
{
  "success": false,
  "error": "Current password is incorrect",
  "timestamp": "2024-01-20T14:22:00Z"
}
```

---

### Test 15: Request Password Reset

```bash
curl -X POST http://localhost:8787/auth/request-password-reset \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com"
  }'
```

**Expected (200):**
```json
{
  "success": true,
  "data": {
    "message": "If this email is registered, password reset instructions have been sent."
  }
}
```

**Note:** Non-existent emails also return 200 (security)

---

## Using Postman

### Import Collection

Create a Postman collection file: `focusbro-api.postman_collection.json`

```json
{
  "info": {
    "name": "FocusBro API",
    "version": "1.0.0"
  },
  "item": [
    {
      "name": "Register",
      "request": {
        "method": "POST",
        "url": "http://localhost:8787/auth/register",
        "header": [
          {"key": "Content-Type", "value": "application/json"}
        ],
        "body": {
          "mode": "raw",
          "raw": "{\"email\": \"test@example.com\", \"password\": \"TestPass123!\"}"
        }
      }
    }
  ]
}
```

Import in Postman:
1. File > Import
2. Select the JSON file
3. Use `{{token}}` as variable for Bearer token

---

## Using JavaScript/Node.js

### Test Script

```javascript
const BASE_URL = 'http://localhost:8787';

async function testAPI() {
  // Register
  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'TestPass123!'
    })
  });
  
  const userData = await registerRes.json();
  const token = userData.token;
  
  console.log('Registered:', userData);
  
  // Get Profile
  const profileRes = await fetch(`${BASE_URL}/users/profile`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  const profile = await profileRes.json();
  console.log('Profile:', profile);
  
  // Upload Data
  const syncRes = await fetch(`${BASE_URL}/sync/data`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: { tasks: [], settings: {} },
      device_id: 'device-test-123'
    })
  });
  
  const syncData = await syncRes.json();
  console.log('Synced:', syncData);
}

testAPI();
```

Run with:
```bash
node test-script.js
```

---

## Load Testing with Artillery

### Install Artillery

```bash
npm install -g artillery
```

### Create Load Test Config

File: `load-test.yml`

```yaml
config:
  target: "http://localhost:8787"
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 120
      arrivalRate: 50
      name: "Ramp up"

scenarios:
  - name: "User Registration Flow"
    flow:
      - post:
          url: "/auth/register"
          json:
            email: "user-{{ $uuid }}@example.com"
            password: "TestPass123!"
      - think: 2
      - get:
          url: "/health"
```

Run test:
```bash
artillery run load-test.yml
```

---

## Monitoring During Tests

### Terminal 1: Run Server
```bash
wrangler dev
```

### Terminal 2: Check Logs
```bash
wrangler tail --format pretty
```

### Terminal 3: Run Tests
```bash
npm test
```

---

## Common Issues

### Database Not Initialized

```bash
wrangler d1 execute focusbro-db --file=schema.sql --local
```

### Cache Issues

Clear KV:
```bash
wrangler kv:key delete --binding KV_CACHE "*"
```

### Token Expiration

After 30 days, re-login:
```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "...", "password": "..."}'
```

---

## Performance Benchmarks

Expected response times (local development):

| Endpoint | Time |
|----------|------|
| Health Check | 5ms |
| Register | 50ms |
| Login | 60ms |
| Get Profile | 20ms |
| Sync Data (100KB) | 100ms |
| List Devices | 15ms |

---

## Test Coverage Goals

Aim for:
- [ ] 90%+ code coverage
- [ ] All endpoints tested
- [ ] Error cases covered
- [ ] Rate limiting verified
- [ ] CORS tested
- [ ] Database integrity checked

---

