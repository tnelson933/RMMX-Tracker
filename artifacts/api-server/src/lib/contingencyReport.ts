// The contingency matching rules are pure and live in the shared package: the
// desktop's offline server builds the same report.
export { buildContingencyReport, normalizeBrand, riderBrandMatch } from "@workspace/api-zod";
export type {
  ContingencyFinisher,
  ContingencyOverallClass,
  ContingencyRiderDetails,
  RiderBrandInfo,
} from "@workspace/api-zod";
