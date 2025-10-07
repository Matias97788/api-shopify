import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { obtenerProductos, actualizarStock, actualizarPrecios } from './shopify.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/products', async (req, res) => {
  try {
    const { products } = await obtenerProductos();
    res.json({ count: products.length, products });
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    res.status(status).json({ error: 'No se pudieron obtener los productos', details: msg });
  }
});

// Actualiza stock (available) de uno o varios items
app.post('/stock', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = body.updates ?? body;

    if (!updates || (Array.isArray(updates) && updates.length === 0)) {
      return res.status(400).json({ error: 'Falta body con updates o un objeto de actualización' });
    }

    const result = await actualizarStock(updates);
    res.json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    res.status(status).json({ error: 'No se pudo actualizar el stock', details: msg });
  }
});

// Actualiza precios (price y opcional compare_at_price) de uno o varios variants
app.post('/prices', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = body.updates ?? body;

    if (!updates || (Array.isArray(updates) && updates.length === 0)) {
      return res.status(400).json({ error: 'Falta body con updates o un objeto de actualización' });
    }

    const result = await actualizarPrecios(updates);
    res.json(result);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.errors || err.message;
    res.status(status).json({ error: 'No se pudieron actualizar los precios', details: msg });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API corriendo en http://localhost:${port}`);
});