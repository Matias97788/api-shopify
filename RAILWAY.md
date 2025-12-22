# Despliegue en Railway (Express)

Este proyecto corre como servidor Express puro (sin funciones serverless). Fue limpiado para desplegar en Railway.

## Requisitos

- Node.js runtime (Railway provee uno automáticamente).
- Scripts en `package.json`:
  - `start`: `node src/server.js`
  - `dev`: `nodemon --watch src src/server.js`
- El servidor usa `process.env.PORT` (Railway lo inyecta).

## Variables de entorno

- `SHOPIFY_STORE_DOMAIN` — dominio de la tienda, ej: `tu-tienda.myshopify.com`
- `SHOPIFY_ADMIN_TOKEN` — token del Admin API
- `SHOPIFY_LOCATION_ID` — Location ID para actualizar stock
- Opcional: `EXTERNAL_STOCK_URL` — fuente externa para sincronización de stock

## Pasos de despliegue

1. Subir el repo a GitHub.
2. Crear un proyecto en Railway y conectar el repo.
3. Configurar las variables de entorno (Service → Variables).
4. Deploy automático por cambios en `main` (o manual desde dashboard).

## Endpoints en producción

- Salud: `GET https://<tu-app>.up.railway.app/health`
- Productos: `GET https://<tu-app>.up.railway.app/products`
- Stock: `POST https://<tu-app>.up.railway.app/stock`
- Precios: `POST https://<tu-app>.up.railway.app/prices`
- Cron manual: `GET https://<tu-app>.up.railway.app/cron/stock-sync`

## Ejemplos curl

Reemplaza `<tu-app>` por el subdominio de tu servicio en Railway.

- Stock — un item por `inventory_item_id`:
  ```bash
  curl -sS -X POST "https://<tu-app>.up.railway.app/stock" \
    -H "Content-Type: application/json" \
    -d '{"inventory_item_id":1234567890,"available":15}'
  ```

- Stock — un item por `variant_id`:
  ```bash
  curl -sS -X POST "https://<tu-app>.up.railway.app/stock" \
    -H "Content-Type: application/json" \
    -d '{"variant_id":987654321,"available":8}'
  ```

- Stock — varios items (batch):
  ```bash
  curl -sS -X POST "https://<tu-app>.up.railway.app/stock" \
    -H "Content-Type: application/json" \
    -d '{"updates":[{"inventory_item_id":111,"available":5},{"variant_id":222,"available":12}]}'
  ```

- Precios — un variant:
  ```bash
  curl -sS -X POST "https://<tu-app>.up.railway.app/prices" \
    -H "Content-Type: application/json" \
    -d '{"variant_id":987654321,"price":19.99,"compare_at_price":24.99}'
  ```

- Precios — varios variants (batch):
  ```bash
  curl -sS -X POST "https://<tu-app>.up.railway.app/prices" \
    -H "Content-Type: application/json" \
    -d '{"updates":[{"variant_id":111,"price":12.5},{"variant_id":222,"price":18.0,"compare_at_price":22.0}]}'
  ```

## Cron de stock

- Si necesitas sincronización automática, usa un scheduler externo (p. ej. cron-job.org) para invocar `GET https://<tu-app>.up.railway.app/cron/stock-sync` cada hora.
- `EXTERNAL_STOCK_URL` debe devolver un array o `{ updates: [...] }` con `{ variant_id, available }`.