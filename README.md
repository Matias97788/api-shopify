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
# Puedes poner uno o varios separados por coma (ej: ID1,ID2)
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
3. Probar los endpoints:
   - `GET http://localhost:3000/products` → devuelve lista simplificada de productos.
      - Paginación: acepta `limit` (hasta 250) y `page_info`. La respuesta incluye `next_page_info` si hay página siguiente.
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
  - `SHOPIFY_LOCATION_ID` (solo necesario para el endpoint de stock; admite varios IDs separados por coma)
- Despliega. Vercel detectará las funciones en `api/`.

### Guía rápida con CLI (opcional)
Si prefieres desplegar desde tu terminal con Vercel CLI:

1) Instala la CLI y autentícate (abre el enlace que enviará Vercel):
```bash
npm i -g vercel
vercel login
```

2) Enlaza el proyecto dentro de esta carpeta (elige tu equipo/proyecto o créalo):
```bash
npm run vercel:link
```

3) Agrega las variables de entorno en el proyecto (producción). Repite para cada una:
```bash
vercel env add SHOPIFY_STORE_DOMAIN production
vercel env add SHOPIFY_ADMIN_TOKEN production
vercel env add SHOPIFY_LOCATION_ID production
# Opcional, solo si usas el cron de stock
vercel env add EXTERNAL_STOCK_URL production
```

4) Despliega a producción:
```bash
npm run vercel:deploy
```

Para desarrollo local con el runtime de Vercel (requiere login y `vercel link`):
```bash
npm run vercel:dev
```

### Endpoints en producción
- `GET https://<tu-proyecto>.vercel.app/api/health`
- `GET https://<tu-proyecto>.vercel.app/api/products` (acepta `limit` y `page_info`)
- `POST https://<tu-proyecto>.vercel.app/api/stock`
- `POST https://<tu-proyecto>.vercel.app/api/prices`
- `GET https://<tu-proyecto>.vercel.app/api/cron-stock-sync` (invocado automáticamente por cron cada hora)

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
- Para listar más de 50 productos, usa paginación con `limit` (máx. 250) y `page_info`. El endpoint `/products` devuelve `next_page_info` si hay más resultados.

## Ejemplos de paginación

- Obtener primeros 50 productos:

```
GET http://localhost:3000/products?limit=50
```

- Si la respuesta incluye `next_page_info`, obtener la siguiente página:

```
GET http://localhost:3000/products?limit=50&page_info=<NEXT_PAGE_INFO>
```

- En Vercel:

```
GET https://<tu-proyecto>.vercel.app/api/products?limit=50
GET https://<tu-proyecto>.vercel.app/api/products?limit=50&page_info=<NEXT_PAGE_INFO>
```

## Cron de sincronización de stock

- Este proyecto incluye un cron horario en Vercel que llama a `GET /api/cron-stock-sync`.
- Configura `EXTERNAL_STOCK_URL` en variables de entorno para que el cron consulte una fuente externa de stock.
- Formato esperado de la fuente externa (se aceptan ambos):

```json
{
  "updates": [
    { "variant_id": 111, "available": 5 },
    { "variant_id": 222, "available": 12 }
  ]
}
```

o bien:

```json
[
  { "variant_id": 111, "available": 5 },
  { "variant_id": 222, "available": 12 }
]
```

- El cron compara el `available` externo con `inventory_quantity` actual de Shopify y solo actualiza los variants donde hay diferencias.
- Si `EXTERNAL_STOCK_URL` no está configurado, el endpoint responde que no hay actualizaciones.
- En desarrollo local, puedes ejecutar manualmente: `GET http://localhost:3000/cron/stock-sync`.
- Si prefieres Storefront API (GraphQL), necesitarás un token de Storefront y otra ruta de consulta.
## Logs

- En desarrollo local:
  - La consola muestra logs HTTP (`morgan`) y detalles de cada llamada a Shopify (método, URL, estado y duración).
  - Verás líneas como:
    - `[HTTP] POST /stock body= {...}`
    - `[Shopify] --> PUT https://<dominio>/admin/api/.../variants/<id>.json`
    - `[Shopify] <-- PUT ... | 200 in 120ms`

- En Vercel (producción):
  - Abre tu proyecto en Vercel → `Logs`.
  - Cada invocación de una función serverless emite `console.log` con:
    - `[API] /api/products called ...` y `success/error`
    - `[API] /api/stock ...` y `success/error`
    - `[API] /api/prices ...` y `success/error`
    - `[API] /api/cron-stock-sync ...` (ejecutado por el cron)
  - Las llamadas a Shopify también se registran vía interceptores:
    - `[Shopify] --> ...`, `[Shopify] <-- ...`, o `[Shopify] !! ...` en caso de error.

> Seguridad: no se loguea el token de acceso. Si necesitas ocultar URLs o payloads completos, podemos ajustar el nivel de detalle.