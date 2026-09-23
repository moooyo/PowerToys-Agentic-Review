import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GithubSourceLink, type GithubSourceLinkProps } from "./github-source-link";

const source: GithubSourceLinkProps = {
  repositoryFullName: "record-owner/Recorded.Repository_1",
  kind: "pull_request",
  number: 42,
};

describe("GitHub source link", () => {
  it.each([
    { kind: "pull_request", path: "pull", label: "PR" },
    { kind: "issue", path: "issues", label: "issue" },
  ] as const)("opens the recorded $kind with native link semantics", ({ kind, path, label }) => {
    const html = renderToStaticMarkup(<GithubSourceLink {...source} kind={kind} />);
    const anchor = html.match(/<a\b[^>]*>/u)?.[0];
    const accessibleLabel =
      `Open ${label} #42 on GitHub · record-owner/Recorded.Repository_1 ` + "(opens in a new tab)";

    expect(anchor).toContain(
      `href="https://github.com/record-owner/Recorded.Repository_1/${path}/42"`,
    );
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(anchor).toContain(`aria-label="${accessibleLabel}"`);
    expect(anchor).not.toContain('role="button"');
    expect(html).toContain(`Open ${label} #42 on GitHub`);
    expect(html).not.toContain("<button");
  });

  it("uses the current record when its repository, kind, and number change", () => {
    const html = renderToStaticMarkup(
      <GithubSourceLink repositoryFullName="other-owner/another-repo" kind="issue" number={7} />,
    );

    expect(html).toContain('href="https://github.com/other-owner/another-repo/issues/7"');
    expect(html).toContain("Open issue #7 on GitHub · other-owner/another-repo");
    expect(html).not.toContain(source.repositoryFullName);
  });

  it.each([
    "",
    "All repositories",
    "owner",
    "owner/repo/extra",
    "https://github.com/owner/repo",
    "owner/repo?tab=readme",
    "owner/repo#section",
    "owner/repo%2Fissues",
    "owner\\repo",
    "../repo",
    "owner/.",
    "owner/..",
    "-owner/repo",
    "owner-/repo",
    "owner/repo\n",
    " owner/repo",
    "owner/repo ",
    `owner/${"r".repeat(101)}`,
    `${"o".repeat(101)}/repo`,
  ])("does not render a link for an invalid repository: %j", (repositoryFullName) => {
    expect(
      renderToStaticMarkup(
        <GithubSourceLink {...source} repositoryFullName={repositoryFullName} />,
      ),
    ).toBe("");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "does not render a link for an invalid source number: %s",
    (number) => {
      expect(renderToStaticMarkup(<GithubSourceLink {...source} number={number} />)).toBe("");
    },
  );

  it.each(["", "pull", "pr", "bug"])("does not infer a route for an invalid kind: %j", (kind) => {
    expect(
      renderToStaticMarkup(
        <GithubSourceLink {...source} kind={kind as GithubSourceLinkProps["kind"]} />,
      ),
    ).toBe("");
  });
});
