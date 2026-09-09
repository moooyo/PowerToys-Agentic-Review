import { CheckOutlined, CopyOutlined, LockOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import { useState } from "react";
import type { WorkerCredentialSecret } from "@/services/review-control";

export interface CredentialRevealModalProps {
  credential: WorkerCredentialSecret | null;
  operation: "created" | "rotated";
  onClose: () => void;
  onCopyError: () => void;
  onCopySuccess: () => void;
}

export function CredentialRevealModal({
  credential,
  operation,
  onClose,
  onCopyError,
  onCopySuccess,
}: CredentialRevealModalProps) {
  const [copying, setCopying] = useState(false);

  const copyToken = async () => {
    if (credential === null) {
      return;
    }
    setCopying(true);
    try {
      if (globalThis.navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable.");
      }
      await globalThis.navigator.clipboard.writeText(credential.token);
      onCopySuccess();
    } catch {
      onCopyError();
    } finally {
      setCopying(false);
    }
  };

  return (
    <Modal
      centered
      closable={false}
      destroyOnHidden
      footer={
        <Button disabled={copying} icon={<CheckOutlined />} onClick={onClose} type="primary">
          I saved the credential
        </Button>
      }
      keyboard={false}
      mask={{ closable: false }}
      onCancel={onClose}
      open={credential !== null}
      title={operation === "created" ? "Worker credential created" : "Worker token rotated"}
      width={680}
    >
      <Space className="credential-reveal" orientation="vertical" size={16}>
        <Alert
          description={
            operation === "created"
              ? "The token cannot be recovered after this window is closed. Store it in the worker authentication file before continuing."
              : "The previous token is already invalid. Replace it in the worker authentication file before closing this window."
          }
          title="Copy this token now"
          showIcon
          type="warning"
        />

        <section aria-label="One-time worker credential" className="credential-reveal__seal">
          <div className="credential-reveal__eyebrow">
            <LockOutlined aria-hidden />
            <span>ONE-TIME WORKER ACCESS</span>
          </div>

          <Space className="credential-reveal__identity" orientation="vertical" size={3}>
            <Typography.Text className="credential-reveal__label">Worker node ID</Typography.Text>
            <Typography.Text className="credential-reveal__node mono">
              {credential?.workerNodeId}
            </Typography.Text>
          </Space>

          <Space className="credential-reveal__token-block" orientation="vertical" size={8}>
            <Typography.Text className="credential-reveal__label">Bearer token</Typography.Text>
            <Input.TextArea
              aria-label="One-time worker token"
              autoSize={{ minRows: 2, maxRows: 3 }}
              className="credential-reveal__token mono"
              readOnly
              spellCheck={false}
              value={credential?.token ?? ""}
            />
            <Button
              className="credential-reveal__copy"
              icon={<CopyOutlined />}
              loading={copying}
              onClick={() => void copyToken()}
            >
              Copy token
            </Button>
          </Space>
        </section>

        <Typography.Paragraph className="credential-reveal__footnote" type="secondary">
          Closing this window removes the token from the dashboard. The dashboard does not place it
          in the URL or browser storage.
        </Typography.Paragraph>
      </Space>
    </Modal>
  );
}
