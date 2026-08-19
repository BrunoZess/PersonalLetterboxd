/**
 * server.js — Backend do CineHub
 *
 * O que ele faz:
 * 1. Faz proxy das chamadas à API da TMDB, escondendo a API key do público
 *    (no site anterior, 100% front-end, a chave ficava visível no navegador).
 * 2. Guarda favoritos e "quero assistir" de cada usuário em um arquivo JSON
 *    local (via lowdb) — sem precisar configurar um banco de dados externo.
 * 3. Cacheia as respostas da TMDB por alguns minutos, pra não estourar o
 *    limite de requisições da API e deixar o site mais rápido.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import { randomUUID } from "crypto";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

if (!TMDB_API_KEY || TMDB_API_KEY === "sua_chave_aqui") {
  console.error(
    "\n⚠️  TMDB_API_KEY não configurada. Copie .env.example para .env e cole sua chave.\n"
  );
  process.exit(1);
}

// ---------- Banco de dados simples (arquivo JSON) para favoritos ----------
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { favorites: {}, watchlist: {} });
await db.read();
db.data ||= { favorites: {}, watchlist: {} };
await db.write();

// ---------- Cache das respostas da TMDB (10 minutos) ----------
const cache = new NodeCache({ stdTTL: 600 });

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// Cada visitante recebe um ID anônimo (via header) para guardar favoritos
// sem precisar de login/senha. O front-end gera e guarda esse ID no localStorage.
function getUserId(req) {
  const id = req.header("x-user-id");
  return id && typeof id === "string" ? id : null;
}

// ---------- Helper: chama a TMDB com cache ----------
async function tmdbGet(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "pt-BR");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`TMDB respondeu ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  cache.set(cacheKey, data);
  return data;
}

// ---------- Rotas de filmes (proxy da TMDB) ----------

app.get("/api/genres", async (req, res) => {
  try {
    const data = await tmdbGet("/genre/movie/list");
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    const data = await tmdbGet("/trending/movie/day");
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/trending-week", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const data = await tmdbGet("/trending/movie/week", { page });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// popular | top_rated | now_playing | upcoming
app.get("/api/category/:name", async (req, res) => {
  const allowed = ["popular", "top_rated", "now_playing", "upcoming"];
  if (!allowed.includes(req.params.name)) {
    return res.status(400).json({ error: "Categoria inválida" });
  }
  try {
    const page = req.query.page || 1;
    const data = await tmdbGet(`/movie/${req.params.name}`, { page });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/discover", async (req, res) => {
  try {
    const { genre, sortBy = "popularity.desc", page = 1 } = req.query;
    const params = { sort_by: sortBy, "vote_count.gte": 50, page };
    if (genre) params.with_genres = genre;
    const data = await tmdbGet("/discover/movie", params);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    if (!query) return res.status(400).json({ error: "Parâmetro 'query' é obrigatório" });
    const data = await tmdbGet("/search/movie", { query, page });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/movie/:id", async (req, res) => {
  try {
    const data = await tmdbGet(`/movie/${req.params.id}`);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- Rotas de usuário anônimo + favoritos/watchlist ----------

// Gera um ID anônimo novo para um visitante que ainda não tem um
app.post("/api/user", (req, res) => {
  res.json({ userId: randomUUID() });
});

app.get("/api/favorites", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  res.json({ favorites: db.data.favorites[userId] || [] });
});

app.post("/api/favorites/:movieId", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  db.data.favorites[userId] = db.data.favorites[userId] || [];
  const movieId = Number(req.params.movieId);
  if (!db.data.favorites[userId].includes(movieId)) {
    db.data.favorites[userId].push(movieId);
    await db.write();
  }
  res.json({ favorites: db.data.favorites[userId] });
});

app.delete("/api/favorites/:movieId", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  const movieId = Number(req.params.movieId);
  db.data.favorites[userId] = (db.data.favorites[userId] || []).filter((id) => id !== movieId);
  await db.write();
  res.json({ favorites: db.data.favorites[userId] });
});

app.get("/api/watchlist", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  res.json({ watchlist: db.data.watchlist[userId] || [] });
});

app.post("/api/watchlist/:movieId", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  db.data.watchlist[userId] = db.data.watchlist[userId] || [];
  const movieId = Number(req.params.movieId);
  if (!db.data.watchlist[userId].includes(movieId)) {
    db.data.watchlist[userId].push(movieId);
    await db.write();
  }
  res.json({ watchlist: db.data.watchlist[userId] });
});

app.delete("/api/watchlist/:movieId", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(400).json({ error: "Cabeçalho x-user-id é obrigatório" });
  await db.read();
  const movieId = Number(req.params.movieId);
  db.data.watchlist[userId] = (db.data.watchlist[userId] || []).filter((id) => id !== movieId);
  await db.write();
  res.json({ watchlist: db.data.watchlist[userId] });
});

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`✅ Backend do CineHub rodando em http://localhost:${PORT}`);
});
