export const analysisQueueCountSql =
  "select count(*) from public.shorts_analysis_jobs where status in ('pending', 'processing')";

export const assertAnalysisQueueEmptyCount = (output) => {
  if (output.trim() !== "0") throw new Error("analysis_queue_non_empty");
};
