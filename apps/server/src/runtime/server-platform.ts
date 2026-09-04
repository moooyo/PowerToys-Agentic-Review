export const assertLinuxServerPlatform = (platform: NodeJS.Platform = process.platform): void => {
  if (platform !== "linux") {
    throw new Error("Agentic Review Server runs only on Linux.");
  }
};
