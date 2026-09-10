import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { pathWithRepositoryScope } from "@/components/RepositoryScope/scope";

export default function WorkspaceRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    navigate(pathWithRepositoryScope("/pull-requests", location.search), { replace: true });
  }, [location.search, navigate]);
  return null;
}
