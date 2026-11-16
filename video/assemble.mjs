// Cuts each recording to its narration, muxes the voice, upscales to 1080p and joins the scenes.
//   node assemble.mjs  →  out/proof-of-edge-demo.mp4
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { scenes } = JSON.parse(readFileSync("script.json", "utf8"));
const durations = JSON.parse(readFileSync("audio/durations.json", "utf8"));
const offsets = JSON.parse(readFileSync("raw/offsets.json", "utf8"));
const PAD = 0.45; // breath between scenes
mkdirSync("out/parts", { recursive: true });

const parts = [];
for (const [i, s] of scenes.entries()) {
  const len = durations[s.id] + PAD;
  const out = `out/parts/${String(i).padStart(2, "0")}-${s.id}.mp4`;
  const fades = [i === 0 ? "fade=t=in:st=0:d=0.6" : null, i === scenes.length - 1 ? `fade=t=out:st=${(len - 0.8).toFixed(2)}:d=0.8` : null].filter(Boolean);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", offsets[s.id].toFixed(3), "-i", `raw/${s.id}.webm`,
    "-i", `audio/${s.id}.mp3`,
    "-t", len.toFixed(3),
    "-filter_complex", `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p${fades.length ? "," + fades.join(",") : ""}[v];[1:a]apad[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    out,
  ]);
  parts.push(out);
  console.log(`${s.id.padEnd(12)} ${len.toFixed(1)} s`);
}
writeFileSync("out/parts.txt", parts.map((p) => `file '${p.replace("out/", "")}'`).join("\n") + "\n");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "out/parts.txt", "-c", "copy", "-movflags", "+faststart", "out/proof-of-edge-demo.mp4"]);
const total = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "out/proof-of-edge-demo.mp4"]).toString());
console.log(`out/proof-of-edge-demo.mp4  ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`);
