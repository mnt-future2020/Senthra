import { createServer } from "node:http";

import { env } from "./config/env.js";
import { app } from "./app.js";
import { seedDatabase } from "./db/seed.js";
import { initRealtime } from "./lib/realtime.js";
import { prisma } from "./lib/prisma.js";
import { startUploadReaper } from "#modules/upload/upload.reaper.js";
import { startRentalDeadlineSweep } from "#modules/purchase-order/rentalHire.sweep.js";
import { startExpiredSessionSweep } from "#modules/auth/session.sweep.js";
import { startSchedulerLoop } from "#modules/reports/reportScheduler.trigger.js";

async function start(): Promise<void> {
  // Ensure the admin + settings exist before accepting requests.
  await seedDatabase();

  // Wrap the Express app in a raw http.Server so socket.io can attach to the
  // same server/port; then bring realtime up before we start listening.
  const httpServer = createServer(app);
  initRealtime(httpServer);

  const server = httpServer.listen(env.PORT, () => {
    console.log(`Server listening on http://localhost:${env.PORT}`);
  });

  // Sweep uploads the browser started and never came back for. An in-process timer rather than a
  // worker or a queue: one abandoned-upload sweep an hour is not a reason to run more infrastructure,
  // and every row is claimed through a conditional update, so several instances sweeping at once is
  // safe — one simply skips what another took.
  const stopReaper = startUploadReaper();
  // Rental deadline reminders — same in-process-timer reasoning as above (rentalHire.sweep.ts).
  const stopRentalSweep = startRentalDeadlineSweep();
  // Remove session rows whose lifetime has already elapsed. Not a retention rule — those rows are
  // already refused by findActive/listSessions/the device cap; this stops the dead row (and the IP
  // on it) outliving the session because nobody happened to present its sid again.
  const stopSessionSweep = startExpiredSessionSweep();
  // Scheduled reports. Same in-process-timer reasoning as the three above, and safe to run on every
  // instance for the same reason: the claim and the (schedule, period) unique key decide what runs.
  //
  // Announced at boot either way. The failure this guards against is nobody noticing that NOTHING
  // drives the sweep — an operator should be able to read what will trigger it from the startup log
  // rather than from a schedule that quietly never fires.
  const stopReportScheduler = env.REPORT_SCHEDULER_IN_PROCESS ? startSchedulerLoop() : null;
  console.info(
    stopReportScheduler
      ? "[report-scheduler] in-process sweep active (every 15m)"
      : `[report-scheduler] in-process sweep DISABLED — an external scheduler must POST ${
          env.REPORT_SCHEDULER_SECRET ? "" : "(NO SECRET CONFIGURED) "
        }/internal/report-scheduler/run at least hourly`,
  );

  const shutdown = async (): Promise<void> => {
    stopReaper();
    // Stopped like the reaper: a pass starting during teardown would query a disconnecting client.
    stopRentalSweep();
    stopSessionSweep();
    stopReportScheduler?.();
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
