import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

// === Définition des chemins ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, "bin");
const YT_EXE = path.join(BIN, "yt-dlp.exe");
const FFMPEG = path.join(BIN, "ffmpeg.exe");
const HAS_YT_EXE = fs.existsSync(YT_EXE);

// === Helper pour exécuter yt-dlp ===
function runYtDlp(args) {
  if (HAS_YT_EXE) {
    return spawn(YT_EXE, args, { cwd: __dirname });
  }
  const pyCmd = process.platform === "win32" ? "py" : "python3";
  return spawn(pyCmd, ["-m", "yt_dlp", ...args], { cwd: __dirname });
}

const app = express();
app.use(cors());

// === Page d'accueil simple ===
app.use(express.static(__dirname));
app.get("/", (_req, res) => {
  res
    .type("text")
    .send("✅ YTB Downloader API\nUtilise /info?url=... ou /download?url=...&format=mp4|mp3");
});

// === Fonction erreur courte ===
function bad(res, msg, code = 400) {
  if (!res.headersSent) res.status(code).json({ error: msg });
}

// === Route /info ===
app.get("/info", (req, res) => {
  const url = req.query.url;
  if (!url) return bad(res, "Il manque ?url=");

  const y = runYtDlp(["-j", "--no-playlist", url]);
  let out = "", err = "";

  y.stdout.on("data", (d) => (out += d));
  y.stderr.on("data", (d) => (err += d));

  y.on("error", () => bad(res, "Impossible de lancer yt-dlp (exe ou python).", 500));
  y.on("close", (code) => {
    if (code !== 0) return bad(res, err || "Échec yt-dlp", 500);
    try {
      const j = JSON.parse(out);
      const formats = (j.formats || []).map((f) => ({
        id: f.format_id,
        ext: f.ext,
        vcodec: f.vcodec,
        acodec: f.acodec,
        fps: f.fps,
        height: f.height,
        note: f.format_note,
      }));
      res.json({
        title: j.title,
        uploader: j.uploader,
        duration: j.duration,
        thumbnails: j.thumbnails,
        formats,
      });
    } catch {
      bad(res, "Parsing info impossible", 500);
    }
  });
});

// === Route /download ===
app.get("/download", (req, res) => {
  const { url, format } = req.query;
  if (!url) return bad(res, "Il manque ?url=");
  if (!["mp4", "mp3"].includes(format))
    return bad(res, "format doit être mp4 ou mp3");

  const tmpDir = path.join(os.tmpdir(), "ytb-downloader");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let args;
if (format === "mp4") {
  args = [
    "--no-playlist",
    "-N", "4",
    "-f",
    "bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]"
    + "/b[ext=mp4][height<=720]"
    + "/b[height<=720]",
    "--merge-output-format", "mp4",
    "-P", tmpDir,
    "-o", "%(title)s.%(ext)s",
    "--print", "after_move:filepath",
    "--restrict-filenames",
    url,
  ];
} else {
    args = [
      "--no-playlist",
      "-N", "4",
      "-f", "ba/b",
      "-P", tmpDir,
      "-o", "%(title)s.%(ext)s", // ✅ corrigé ici
      "-x", "--audio-format", "mp3",
      "--audio-quality", "192K",
      "--print", "after_move:filepath",
      "--restrict-filenames",
      url,
    ];
  }

  const y = runYtDlp(args);
  let finalPath = null;
  let stderrBuf = "";

  y.stdout.on("data", (d) => {
    const line = d.toString().trim();
    if (line && fs.existsSync(line)) {
      finalPath = line;
    }
  });

  y.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  y.on("error", () => bad(res, "yt-dlp introuvable (exe ou python).", 500));

  y.on("close", (code) => {
    if (code !== 0 || !finalPath) {
      return bad(res, `Échec téléchargement (${code}). ${stderrBuf || ""}`, 500);
    }

    // Envoi du fichier terminé
    const stat = fs.statSync(finalPath);
    const filename = path.basename(finalPath);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/"/g, "")}"`
    );
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Type",
      format === "mp3" ? "audio/mpeg" : "video/mp4"
    );

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    // Nettoyage du fichier après envoi
    const cleanup = () =>
      fs.existsSync(finalPath) && fs.unlink(finalPath, () => {});
    res.on("close", cleanup);
    res.on("finish", cleanup);
  });
});

// === Lancement du serveur ===
const PORT = process.env.PORT || 2626;
app.listen(PORT, () => {
  console.log(`✅ Serveur prêt sur http://localhost:${PORT}`);
  console.log(
    HAS_YT_EXE
      ? "yt-dlp.exe détecté ✔️"
      : "⚠️ yt-dlp.exe non trouvé — fallback via python -m yt_dlp"
  );
});
