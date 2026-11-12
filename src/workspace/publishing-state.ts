// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type MergeRequestState = "checking" | "open" | "none" | "error";

export function publishingAvailability({
  branch,
  targetBranch,
  commitsKnown,
  unpublished,
  mergeRequestState,
}: {
  branch?: string;
  targetBranch?: string;
  commitsKnown: boolean;
  unpublished: boolean;
  mergeRequestState: MergeRequestState;
}) {
  return {
    pushDisabled: !branch || !commitsKnown || !unpublished,
    mergeRequestDisabled: !branch || !targetBranch || branch === targetBranch || mergeRequestState === "open",
    mergeRequestChecking: mergeRequestState === "checking",
  };
}
