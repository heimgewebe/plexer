# plexer

A TypeScript-based Express application.

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Production

```bash
npm run build
npm start
```

## Configuration

The application can be configured using environment variables:

- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)
- `NODE_ENV` - Environment (default: development)

## API Endpoints

- `GET /` - Welcome message
- `GET /health` - Health check endpoint
