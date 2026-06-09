import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { JobTitle } from "@/types/jobTitle";

// Typed wrappers around the backend /job-titles endpoints. Mirrors department.service:
// a module-level stale-while-revalidate cache kept in sync on mutations.

let jobTitlesCache: JobTitle[] | null = null;
registerClientCache(() => {
  jobTitlesCache = null;
});
export const getCachedJobTitles = (): JobTitle[] | null => jobTitlesCache;

const byName = (a: JobTitle, b: JobTitle) => a.name.localeCompare(b.name);

export function listJobTitles(): Promise<JobTitle[]> {
  return api<{ jobTitles: JobTitle[] }>("/job-titles").then((r) => {
    jobTitlesCache = r.jobTitles;
    return r.jobTitles;
  });
}

export function createJobTitle(name: string): Promise<JobTitle> {
  return api<{ jobTitle: JobTitle }>("/job-titles", { method: "POST", body: { name } }).then((r) => {
    if (jobTitlesCache) jobTitlesCache = [...jobTitlesCache, r.jobTitle].sort(byName);
    return r.jobTitle;
  });
}

export function updateJobTitle(id: string, name: string): Promise<JobTitle> {
  return api<{ jobTitle: JobTitle }>(`/job-titles/${id}`, { method: "PUT", body: { name } }).then(
    (r) => {
      if (jobTitlesCache) {
        jobTitlesCache = jobTitlesCache.map((d) => (d.id === id ? r.jobTitle : d)).sort(byName);
      }
      return r.jobTitle;
    },
  );
}

export function deleteJobTitle(id: string): Promise<void> {
  return api(`/job-titles/${id}`, { method: "DELETE" }).then(() => {
    if (jobTitlesCache) jobTitlesCache = jobTitlesCache.filter((d) => d.id !== id);
    return undefined;
  });
}
