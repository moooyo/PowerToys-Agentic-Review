import { LoginOutlined } from "@ant-design/icons";
import { Button, Result } from "antd";

export default function SignedOutPage() {
  return (
    <Result
      status="success"
      title="Signed out"
      subTitle="Your local Agentic Review session has ended."
      extra={
        <Button href="/api/v1/auth/login" icon={<LoginOutlined />} key="sign-in" type="primary">
          Sign in
        </Button>
      }
    />
  );
}
