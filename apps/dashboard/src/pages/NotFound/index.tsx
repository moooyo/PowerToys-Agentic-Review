import { Box, Button, Typography } from "@mui/material";
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", px: 3, pt: "16vh" }}>
      <Typography variant="overline" color="text.secondary">
        404
      </Typography>
      <Typography variant="h1" sx={{ mb: 1 }}>
        Page not found
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        This page may have moved. Return to your review workspace.
      </Typography>
      <Button component={Link} to="/pull-requests" variant="contained">
        Open review inbox
      </Button>
    </Box>
  );
}
