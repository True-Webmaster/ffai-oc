import os from "node:os";
import path from "node:path";

export function hermesHome() {
  return process.env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
}

export function hermesConfigPath() {
  return path.join(hermesHome(), "config.yaml");
}

export function hermesEnvPath() {
  return path.join(hermesHome(), ".env");
}
