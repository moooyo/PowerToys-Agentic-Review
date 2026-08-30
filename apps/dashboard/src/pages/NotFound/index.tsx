import { history } from "@umijs/max";
import { Button, Result } from "antd";

export default function NotFoundPage() {
  return (
    <Result
      extra={
        <Button type="primary" onClick={() => history.push("/work-items")}>
          Return to work items
        </Button>
      }
      status="404"
      subTitle="The requested dashboard route does not exist."
      title="Page not found"
    />
  );
}
