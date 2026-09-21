import pino from "pino";
import { cfg } from "../config.js";

export const logger = pino({ level: cfg.logLevel });
