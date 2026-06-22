# Cloudflare Worker for Rental Property Manager

## Setup Instructions

### 1. KV Namespace Created ✅

A KV namespace has been created for storing rental data:
- **Binding**: `RENTALS`
- **ID**: `75372b2a892343c8b45e3d8abafcbce3`

### 2. Admin Password Set ✅

The `ADMIN_PASSWORD` secret has been configured for API access.

### 3. Deployed ✅

Worker is deployed at: `https://rentals-api.99redder.workers.dev`

## API Endpoints

### POST /api/data

```json
{
  "action": "get" | "save",
  "property": "6AL" | "95EB" | "446BB" | "731WO" | "4781MC",
  "transactions": [...]  // required for save action
}
```

## Local Development

```bash
cd cloudflare
npx wrangler dev
```

## index.html Configuration

Update the API endpoint in `index.html`:

```javascript
const API_BASE = 'https://rentals-api.99redder.workers.dev';
```
