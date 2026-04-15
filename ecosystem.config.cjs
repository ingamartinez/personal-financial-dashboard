module.exports = {
  apps: [
    {
      name: "findash",
      script: "bun",
      args: "run start",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: "3100",
      },
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
      time: true,
    },
  ],
};
