// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type FileOperationPhase = "listing" | "downloading" | "importing" | "preparing" | "finalizing" | "compiling" | "rendering";
export interface FileOperationProgress {
  phase: FileOperationPhase;
  completed?: number;
  total?: number;
}
const phaseLabels: Record<FileOperationPhase, string> = {
  listing: "Reading file lists",
  downloading: "Downloading files",
  importing: "Importing files",
  preparing: "Preparing files",
  finalizing: "Finalizing import",
  compiling: "Compiling document",
  rendering: "Rendering preview",
};

export function fileOperationProgressText({ phase, completed, total }: FileOperationProgress): string {
  const label = phaseLabels[phase];
  if (completed !== undefined) {
    return total !== undefined ? `${label}: ${completed}/${total}…` : `${label}: ${completed} downloaded…`;
  }
  return `${label}…`;
}

export function createFileOperationProgress(report: (message: string) => void, now: () => number = () => performance.now()) {
  let previousPhase: FileOperationPhase;
  let previousTime = -Infinity;
  return (progress: FileOperationProgress) => {
    const time = now();
    const boundary = progress.phase !== previousPhase || progress.completed === 0 || (progress.total !== undefined && progress.completed === progress.total);
    if (!boundary && time - previousTime < 150) return;
    previousPhase = progress.phase;
    previousTime = time;
    report(fileOperationProgressText(progress));
  };
}
