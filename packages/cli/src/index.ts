import { buildCli } from "./cli.js";
import { buildCliContext } from "./context/CliContext.js";

const cli = buildCli();
const context = buildCliContext();

const exitCode = await cli.run(process.argv.slice(2), context);
process.exit(exitCode);
