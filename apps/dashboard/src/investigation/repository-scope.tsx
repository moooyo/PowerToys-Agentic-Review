import { Autocomplete, Box, TextField } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { investigationApi } from "./api";

export function useInvestigationRepositoryScope() {
  const location = useLocation();
  const repositoryId = new URLSearchParams(location.search).get("repositoryId") || undefined;
  const query = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
    retry: false,
  });
  return {
    repositoryId,
    repository: query.data?.items.find((item) => item.id === repositoryId),
    query,
  };
}

export function InvestigationRepositorySelector({ fullWidth = false }: { fullWidth?: boolean }) {
  const scope = useInvestigationRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const options = [
    { id: "", fullName: "All repositories", githubRepositoryId: 0 },
    ...(scope.query.data?.items ?? []),
  ];
  const selected = options.find((item) => item.id === (scope.repositoryId ?? ""));
  if (!selected && scope.repositoryId)
    options.push({
      id: scope.repositoryId,
      fullName: "Repository unavailable",
      githubRepositoryId: 0,
    });
  return (
    <Box
      sx={{
        width: fullWidth ? "100%" : { xs: 176, sm: 284 },
        flex: fullWidth ? 1 : undefined,
        minWidth: 0,
      }}
    >
      <Autocomplete
        disableClearable
        size="small"
        options={options}
        loading={scope.query.isPending}
        getOptionLabel={(option) => option.fullName}
        isOptionEqualToValue={(left, right) => left.id === right.id}
        value={options.find((item) => item.id === (scope.repositoryId ?? "")) ?? options[0]}
        onChange={(_event, option) => {
          const parameters = new URLSearchParams(location.search);
          if (option.id) parameters.set("repositoryId", option.id);
          else parameters.delete("repositoryId");
          parameters.delete("workItemId");
          parameters.delete("taskId");
          parameters.delete("reportId");
          parameters.delete("commentId");
          navigate({ pathname: location.pathname, search: parameters.toString() });
        }}
        renderInput={(parameters) => (
          <TextField
            {...parameters}
            label="Repository"
            error={scope.query.isError}
            helperText={scope.query.isError ? "Repository directory unavailable" : undefined}
          />
        )}
      />
    </Box>
  );
}
