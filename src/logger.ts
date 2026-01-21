import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

// Child loggers for different modules
export const botLogger = logger.child({ module: "bot" });
export const aiLogger = logger.child({ module: "ai" });
export const toolLogger = logger.child({ module: "tools" });
export const syncLogger = logger.child({ module: "sync" });
