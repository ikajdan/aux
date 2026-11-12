// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IconName } from "./ui-icons.js";

export const latexSnippets: readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly description: string;
  readonly text: string;
  readonly cursorOffset?: number;
}[] = [
  {
    id: "figure",
    label: "Figure",
    icon: "image",
    description: "Requires graphicx and float.",
    text: String.raw`\begin{figure}[H]
    \includegraphics[width=0.1\textwidth]{assets/image.png}
    \caption{Example figure.}
    \label{fig:example_figure}
\end{figure}`,
  },
  {
    id: "table",
    label: "Table",
    icon: "table",
    description: "Requires tabularx, booktabs, and float.",
    text: String.raw`\begin{table}[H]
    \caption{Example table.}
    \label{tab:example_table}
    \begin{tabularx}{0.3\textwidth}{Xr}
        \toprule
        \textbf{Parameter} & \textbf{Value} \\
        \midrule
        Example parameter & Placeholder \\
        Another parameter & Placeholder \\
        \bottomrule
    \end{tabularx}
\end{table}`,
  },
  {
    id: "wide-table",
    label: "Wide table",
    icon: "table-wide",
    description: "Requires tabularx, booktabs, float, xcolor with the table option, and array.",
    text: String.raw`\begin{table}[H]
    \caption{Example long table.}
    \label{tab:wide_dummy_table}
    \centering
    \rowcolors{2}{gray!15}{white}
    \begin{tabularx}{\textwidth}{>{\raggedright\arraybackslash}X >{\raggedright\arraybackslash}X >{\raggedright\arraybackslash}X l l l l >{\raggedright\arraybackslash}X}
        \toprule
        \rowcolor{white}
        \textbf{Item} & \textbf{Heading} & \textbf{Heading} & \textbf{Field} & \textbf{Field} & \textbf{Field} & \textbf{Field} & \textbf{Heading} \\
        \midrule
        Example & Sample text & Sample text & Text & Text & Text & Text & Sample text \\
        Example & Sample text & Sample text & Text & Text & Text & Text & Sample text \\
        Example & Sample text & Sample text & Text & Text & Text & Text & Sample text \\
        Example & Sample text & Sample text & Text & Text & Text & Text & Sample text \\
        Example & Sample text & Sample text & Text & Text & Text & Text & Sample text \\
        \bottomrule
    \end{tabularx}
\end{table}`,
  },
  {
    id: "listing",
    label: "Code listing",
    icon: "code-listing",
    description: "Requires listings.",
    text: String.raw`\begin{lstlisting}[language=Python, caption={Example listing.}, label={lst:example_listing}]
def hello_world():
    print("Hello, world!")

if __name__ == "__main__":
    hello_world()
\end{lstlisting}`,
  },
  {
    id: "note",
    label: "Note",
    icon: "note",
    description: "Requires the document’s custom block environment with the note option.",
    text: String.raw`\begin{block}[note]
This is a note.
\end{block}`,
  },
  {
    id: "warning",
    label: "Warning",
    icon: "warning",
    description: "Requires the document’s custom block environment with the warning option.",
    text: String.raw`\begin{block}[warning]
This is a warning.
\end{block}`,
  },
  {
    id: "important",
    label: "Important",
    icon: "important",
    description: "Requires the document’s custom block environment with the important option.",
    text: String.raw`\begin{block}[important]
This is important.
\end{block}`,
  },
  {
    id: "itemize",
    label: "Itemize list",
    icon: "list-bullets",
    description: "No additional packages required.",
    text: "\\begin{itemize}\n    \\item \n\\end{itemize}",
    cursorOffset: "\\begin{itemize}\n    \\item ".length,
  },
  {
    id: "enumerate",
    label: "Enumerate list",
    icon: "list-numbers",
    description: "No additional packages required.",
    text: "\\begin{enumerate}\n    \\item \n\\end{enumerate}",
    cursorOffset: "\\begin{enumerate}\n    \\item ".length,
  },
];
