export const mustGetEnv = (key: string): string => {
  const value = process.env[key];
  if (!value || value === "") {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
};
