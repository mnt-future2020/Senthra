import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth.routes.js";
import settingsRouter from "./routes/settings.routes.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

export const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "backend" });
});

// Feature routes
app.use("/auth", authRouter);
app.use("/settings", settingsRouter);

// 404 + centralized error handling (must be registered last)
app.use(notFound);
app.use(errorHandler);
