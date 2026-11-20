// Sprint-enduro scoring is pure and lives in the shared package: the desktop's
// offline server runs the same code for the event overall.
export {
  compareEnduroOverall,
  computeEnduroOverall,
  pairEnduroRuns,
  rankEnduroTest,
} from "@workspace/api-zod";
export type {
  EnduroOverallResultInput,
  EnduroOverallRiderInput,
  EnduroOverallRow,
  EnduroOverallStatus,
  EnduroOverallTest,
  EnduroOverallTestCell,
  EnduroRun,
  EnduroTestEntry,
} from "@workspace/api-zod";
