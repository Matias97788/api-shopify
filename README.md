# API Shopify (Listado de Productos)

API en Node.js/Express que se conecta a una tienda Shopify y expone endpoints para listar productos, actualizar stock y actualizar precios. Pensada para uso server-side con el **Admin API** de Shopify.

## Pasos para obtener acceso a Shopify

- Entra al admin de tu tienda Shopify.
- Ve a `Configuración` → `Apps y canales de venta` → `Desarrollar apps` (o "Develop apps").
- Crea una **app personalizada** y otorga el scope `read_products` del **Admin API**.
- Instala la app en la tienda y copia el **Admin API access token**.
- Tu dominio de tienda es el subdominio, por ejemplo: `tienda-demo-mr.myshopify.com`.

> Nota: El Admin API es para uso en servidor y requiere token. Alternativamente, puedes usar el **Storefront API** (token distinto) para leer productos de forma más pública, pero aquí usamos Admin API por simplicidad.

## Variables de entorno

Crea un archivo `.env` (o copia de `.env.example` si está disponible):

```
PORT=3000
SHOPIFY_STORE_DOMAIN=tienda-demo-mr.myshopify.com
SHOPIFY_ADMIN_TOKEN=tu_token_admin_api
# Necesario para actualizar stock (obtén el ID de Location desde el admin)
SHOPIFY_LOCATION_ID=tu_location_id
```

## Cómo ejecutar

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Ejecutar en desarrollo:
   ```bash
   npm run dev
   ```
3. Probar el endpoint:
   - `GET http://localhost:3000/products` → devuelve lista simplificada de productos.
   - `GET http://localhost:3000/health` → estado del servicio.
   - `POST http://localhost:3000/stock` → actualiza stock de uno o varios items.
   - `POST http://localhost:3000/prices` → actualiza precio (y opcional `compare_at_price`) de uno o varios variants.

## Despliegue en Vercel

Este proyecto está listo para desplegarse en Vercel usando funciones serverless en `api/`.

### Pasos
- Importa el repositorio en Vercel.
- Configura las variables de entorno en Vercel (Project Settings → Environment Variables):
  - `SHOPIFY_STORE_DOMAIN`
  - `SHOPIFY_ADMIN_TOKEN`
  - `SHOPIFY_LOCATION_ID` (solo necesario para el endpoint de stock)
- Despliega. Vercel detectará las funciones en `api/`.

### Endpoints en producción
- `GET https://<tu-proyecto>.vercel.app/api/health`
- `GET https://<tu-proyecto>.vercel.app/api/products`
- `POST https://<tu-proyecto>.vercel.app/api/stock`
- `POST https://<tu-proyecto>.vercel.app/api/prices`

Los cuerpos de las peticiones son idénticos a los ejemplos de desarrollo en este README.

> Nota: El archivo `src/server.js` se usa para desarrollo local. En Vercel, los endpoints están implementados en `api/` y no requieren el servidor Express.

### Ejemplos `POST /stock`

- Actualizar un solo item por `inventory_item_id`:

```json
{
  "inventory_item_id": 1234567890,
  "available": 15
}
```

- Actualizar un solo item por `variant_id` (el sistema resuelve el `inventory_item_id`):

```json
{
  "variant_id": 987654321,
  "available": 8
}
```

- Actualizar varios items a la vez:

```json
{
  "updates": [
    { "inventory_item_id": 111, "available": 5 },
    { "variant_id": 222, "available": 12 }
  ]
}
```

### Ejemplos `POST /prices`

- Actualizar un solo variant por `variant_id` (precio y opcional `compare_at_price`):

```json
{
  "variant_id": 987654321,
  "price": 19.99,
  "compare_at_price": 24.99
}
```

- Actualizar varios variants a la vez:

```json
{
  "updates": [
    { "variant_id": 111, "price": 12.50 },
    { "variant_id": 222, "price": 18.00, "compare_at_price": 22.00 }
  ]
}
```

Notas:
- `price` y `compare_at_price` se envían como número o string; internamente se convierten a string conforme al Admin API.
- Es obligatorio incluir `variant_id` y `price` en cada item.

## Estructura del proyecto

- `package.json` — scripts y dependencias.
- `.env.example` — ejemplo de variables requeridas.
- `.gitignore` — archivos ignorados.
- `src/server.js` — servidor Express y endpoints.
- `src/shopify.js` — cliente hacia Shopify Admin API (listar productos, actualizar stock y precios). Las funciones exportadas están en español:
  - `obtenerProductos`
  - `obtenerInventoryItemIdDeVariante`
  - `establecerNivelInventario`
  - `actualizarStock`
  - `actualizarPrecioVariante`
  - `actualizarPrecios`

## Consideraciones

- La tienda protegida con contraseña no afecta el acceso del Admin API (se usa token de admin).
- Ajusta la versión del API de Shopify en `src/shopify.js` si es necesario (usamos `2024-10`).
- Para listar más de 50 productos, implementa paginación usando `page_info` y el parámetro `limit` del Admin API.
- Si prefieres Storefront API (GraphQL), necesitarás un token de Storefront y otra ruta de consulta.