// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export class EditorDraft {
  private current = "";
  private baseline = "";

  load(text: string): void {
    this.baseline = text;
    this.current = text;
  }

  update(text: string): void {
    this.current = text;
  }

  get text(): string { return this.current; }
  get savedText(): string { return this.baseline; }
  get dirty(): boolean { return this.current !== this.baseline; }

  snapshot(): string {
    return this.current;
  }

  saved(text: string): void {
    this.baseline = text;
  }

  discard(): string {
    this.current = this.baseline;
    return this.current;
  }
}
