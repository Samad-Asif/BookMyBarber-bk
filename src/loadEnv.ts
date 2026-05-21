import dotenv from "dotenv";
import path from "path";

/** Load .env before any config module reads process.env (import this file first). */
dotenv.config({ path: path.resolve(__dirname, "../.env") });
