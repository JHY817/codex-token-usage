const COLORS = ["#177c69", "#766fb2", "#c88545", "#527a9c", "#a56575", "#6f786d"];

const MODEL_NAMES = new Map([
  ["gpt-5.6-sol", "GPT-5.6 SOL"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["codex-auto-review", "自动审查"],
  ["unknown", "未知模型"],
]);

const EFFORT_NAMES = new Map([
  ["ultra", "Ultra"],
  ["max", "Max"],
  ["xhigh", "极高"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["minimal", "Minimal"],
  ["none", "None"],
  ["unknown", "未知档位"],
]);

export function modelName(model) {
  return MODEL_NAMES.get(model) ?? model.replace(/^gpt-/, "GPT-");
}

export function effortName(effort) {
  return EFFORT_NAMES.get(effort) ?? effort;
}

export function modelEffortLabel(model, effort) {
  return `${modelName(model)} · ${effortName(effort)}`;
}

export function colorForIndex(index) {
  return COLORS[index % COLORS.length];
}
