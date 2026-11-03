messenger.ipCountry.registerSearchTerm().then((result) => {
  if (!result.ok) {
    console.error(
      `IP Country Filter failed during ${result.stage}: ${result.message}\n${result.stack ?? ""}`
    );
  }
}).catch((error) => {
  console.error("IP Country Filter API call failed:", error?.stack ?? String(error));
});

