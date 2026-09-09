import { Breadcrumb, Typography, theme } from "antd";
import type { ReactNode } from "react";
import "./index.css";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  titleId?: string;
  description: string;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, titleId, description, actions }: PageHeaderProps) {
  const { token } = theme.useToken();
  return (
    <header className="page-header">
      <Breadcrumb
        className="page-header__breadcrumb"
        items={[{ title: eyebrow === "Review workspace" ? "Workspace" : eyebrow }, { title }]}
      />
      <div className="page-header__main">
        <Typography.Title
          id={titleId}
          level={1}
          style={{
            margin: 0,
            fontSize: token.fontSizeHeading3,
            lineHeight: token.lineHeightHeading3,
          }}
        >
          {title}
        </Typography.Title>
        {actions ? <div className="page-header__actions">{actions}</div> : null}
      </div>
      <Typography.Paragraph type="secondary" className="page-header__description">
        {description}
      </Typography.Paragraph>
    </header>
  );
}
