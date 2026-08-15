// Exportables
import { workerMainLoop } from "./src/worker/loop.ts";
import {
  checkCompiledWorker,
  createPool,
  importTask,
  isMain,
  setModuleUrl,
  task,
} from "./src/api.ts";
import { Envelope } from "./src/common/envelope.ts";
import {
  isNumericArray,
  NumericArray,
} from "./src/connections/numeric-array.ts";
export {
  checkCompiledWorker as checkCompiledWorker,
  createPool as createPool,
  Envelope as Envelope,
  importTask as importTask,
  isMain as isMain,
  isNumericArray as isNumericArray,
  NumericArray as NumericArray,
  setModuleUrl as setModuleUrl,
  task as task,
  workerMainLoop as workerMainLoop,
};
export type {
  EnvelopeBody as EnvelopeBody,
  EnvelopeHeader as EnvelopeHeader,
} from "./src/common/envelope.ts";
export type {
  CompiledWorkerCheck,
  CompiledWorkerOptions,
  CompiledWorkerSource,
} from "./src/types.ts";
