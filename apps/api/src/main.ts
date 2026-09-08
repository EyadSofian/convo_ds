import 'reflect-metadata';
import { bootFailureMessage, startApi } from './app.js';

void startApi(process.env).catch((error: unknown) => {
  console.error(bootFailureMessage(error));
  process.exitCode = 1;
});
