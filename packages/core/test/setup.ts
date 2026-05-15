// Test fixtures should see only what they explicitly create — not the bundled default
// model profiles that ship for the zero-config first-run experience.
process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
// Never spawn real `ollama serve` during tests, regardless of provider client paths.
process.env.TIERKIT_DISABLE_AUTO_LAUNCH = "1";
