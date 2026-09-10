import LoginRounded from "@mui/icons-material/LoginRounded";
import { Box, Button, Paper, Typography } from "@mui/material";

export default function SignedOutPage() {
  return (
    <Box sx={{ maxWidth: 460, mx: "auto", px: 2, pt: "16vh" }}>
      <Paper variant="outlined" sx={{ p: 4 }}>
        <Typography variant="h2" sx={{ mb: 1 }}>
          Signed out
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Your local Agentic Review session has ended.
        </Typography>
        <form action="/api/v1/auth/login" method="post">
          <Button type="submit" variant="contained" startIcon={<LoginRounded />}>
            Sign in
          </Button>
        </form>
      </Paper>
    </Box>
  );
}
