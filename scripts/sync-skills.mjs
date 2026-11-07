// Copies the game's live skill files into this repo as Agent Skills
// (skills/<name>/SKILL.md with name and description front matter), so skill
// hubs and plugin installers that read GitHub repos find them:
//
//   skills/agentic-kingdoms/SKILL.md     <- https://agentickingdoms.com/skill.md
//   skills/agentic-kingdoms-zh/SKILL.md  <- https://agentickingdoms.com/skill.zh.md
//
// The website is the source; never edit the SKILL.md files by hand. Run
// `node scripts/sync-skills.mjs` (Node 22+, no dependencies) and commit.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const skills = [
  {
    dir: "agentic-kingdoms",
    url: "https://agentickingdoms.com/skill.md",
    description:
      "Play Agentic Kingdoms, a free strategy MMO in the browser where AI agents and humans play in the same " +
      "kingdoms: build a city, train troops, join an alliance, fight for the Palace. Use it when the user asks to " +
      "join, play a visit of, or check on Agentic Kingdoms, or to join the Humans vs AI war. Uses the " +
      "agentic-kingdoms MCP server (https://mcp.agentickingdoms.com, Streamable HTTP, no key); the agent plays an " +
      "account that carries an AI tag every player sees.",
  },
  {
    dir: "agentic-kingdoms-zh",
    url: "https://agentickingdoms.com/skill.zh.md",
    description:
      "玩 Agentic Kingdoms：一款免费的网页版策略 MMO，真人玩家和 AI 智能体在同一个王国里一起玩——建设城市、训练军队、" +
      "加入联盟、争夺王宫。当用户要求加入、玩一次或查看 Agentic Kingdoms，或参加人类对 AI 之战时使用。需要 " +
      "agentic-kingdoms MCP 服务器（https://mcp.agentickingdoms.com，Streamable HTTP，无需密钥）；" +
      "智能体使用的账号带有 AI 标记，所有玩家都能看到。",
  },
];

const yamlString = (s) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar

for (const s of skills) {
  const res = await fetch(s.url);
  if (!res.ok) throw new Error(`${s.url}: HTTP ${res.status}`);
  const body = (await res.text()).replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (!body.startsWith("# ")) throw new Error(`${s.url}: unexpected content`);
  const front = [
    "---",
    `name: ${s.dir}`,
    `description: ${yamlString(s.description)}`,
    "license: MIT",
    "metadata:",
    `  source: ${s.url}`,
    "  homepage: https://agentickingdoms.com/agents",
    "---",
    "",
  ].join("\n");
  const out = join(root, "skills", s.dir, "SKILL.md");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, front + body, "utf8");
  console.log(`wrote ${out} (${body.length} chars from ${s.url})`);
}
