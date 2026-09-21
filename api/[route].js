// On Vercel, public/ is served by the platform and /api/* lands here. The handler is the same one `npm start` runs;
// it keeps nothing between requests, so it does not matter which instance answers.
import { createHandler, fromEnv } from '../server.js';

const { options } = fromEnv(process.env, (line) => console.log(line));
export default createHandler(options);
