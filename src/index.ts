import { logger } from "./config/pino.js";
import { TokenGrabber } from "./structures/scrape.js";
import { app } from "./api/express.js";
import { Calendar } from "./structures/calendar.js";
import dotenv from "dotenv";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import dayjs from "dayjs";
import { AssignmentDetails, AssignmentList } from "./types/assignment.js";
import { MissingAssignmentDetails } from "./types/missing.js";
import { ScheduleDetails } from "./types/schedule.js";
import cron from "node-cron";
import fs from "fs/promises";
// @ts-expect-error The module is not typed
import Cronitor from "cronitor";
dotenv.config();

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(advancedFormat);

const cronitor = Cronitor();

const calMonitor = new cronitor.Monitor("Create Calendars");

const tokenGrabber = new TokenGrabber();

const listener = app.listen(Number(process.env.PORT) || 3000, () => {
	logger.info(listener.address(), "Your app has started");
});
tokenGrabber.once("ready", async () => {
	logger.trace("Ready event fired");

	await createAssignmentCalendar();
	await createMissingCalendar();
	await createScheduleCalendar();

	cron.schedule("*/5 * * * *", async () => {
		logger.trace("Cron Fired");

		logger.trace("Creating Assignment Calendar");
		await calMonitor.ping({ state: "run" });
		await createAssignmentCalendar();
		logger.trace("Assignment Calendar Created");

		logger.trace("Creating Missing Calendar");
		await createMissingCalendar();
		logger.trace("Missing Calendar Created");

		logger.trace("Creating Schedule Calendar");
		await createScheduleCalendar();
		await calMonitor.ping({ state: "complete" });
		logger.trace("Schedule Calendar Created");
	});
});

async function createAssignmentCalendar(): Promise<void> {
	logger.trace("Generating New Assignment Calendar");
	const assignments = await tokenGrabber.getAssignments();
	if (!assignments) return;

	const calendar = new Calendar();
	calendar.setType("ASSIGNMENT");

	const json: AssignmentList = await readAssignments();

	assignments.map(async (assignment: AssignmentDetails) => {
		calendar.addEvent({
			summary: assignment.Title,
			description: assignment.LongDescription,
			id: assignment.AssignmentId,
			start: dayjs(assignment.DateDue).toDate(),
			allDay: true,
		});

		const id = generateID(assignment);

		if (json[id] != undefined) return;
		json[id] = {
			class: assignment.GroupName,
			name: assignment.Title,
			type: assignment.AssignmentType,
			description: assignment.LongDescription,
			creationDate: dayjs()
				.tz("America/Chicago")
				.format("MM/DD/YYYY hh:mm:ss A z"),
			setAssignedDate: assignment.DateAssigned,
			dueDate: assignment.DateDue,
		};

		logger.info(`New Assignment: ${assignment.Title}`);
	});

	await fs.writeFile("./public/assignments.json", JSON.stringify(json));
	logger.info("Assignments Saved to JSON");

	await calendar.saveCalendar();
	logger.info("New Assignment Calendar Generated");
}

async function createMissingCalendar(): Promise<void> {
	logger.trace("Generating New Missing Calendar");
	const assignments = await tokenGrabber.getMissing();
	if (!assignments) return;

	const calendar = new Calendar();
	calendar.setType("MISSING");

	assignments.map((assignment: MissingAssignmentDetails) => {
		calendar.addEvent({
			summary: assignment.AssignmentTitle,
			description: assignment.AssignmentLongDescription,
			id: assignment.AssignmentId,
			start: dayjs().toDate(),
			priority: 9,
			allDay: true,
		});
	});

	await calendar.saveCalendar();
	logger.info("New Missing Calendar Generated");
}

async function createScheduleCalendar(): Promise<void> {
	logger.trace("Generating New Schedule Calendar");
	const schedules = await tokenGrabber.getSchedule();
	if (!schedules) return;

	const calendar = new Calendar();
	calendar.setType("SCHEDULE");

	schedules.map((schedule: ScheduleDetails) => {
		calendar.addEvent({
			summary: schedule.Title,
			start: dayjs(schedule.StartDate).toDate(),
			end: dayjs(schedule.EndDate).toDate(),
			allDay: schedule.AllDay,
			description: `Attendance: ${schedule.AttendanceDesc}`,
		});
	});

	await calendar.saveCalendar();
	logger.info("New Schedule Calendar Generated");
}

async function readAssignments() {
	let j = {};

	try {
		j = JSON.parse(
			await fs.readFile("./public/assignments.json", {
				encoding: "utf-8",
				flag: "a+",
			})
		);
	} catch {
		j = {};
		await fs.writeFile("./public/assignments.json", JSON.stringify({}));
	}

	logger.info("Assignments Read from JSON");
	return j;
}

function generateID(assignment: AssignmentDetails) {
	let id = "";

	// Assignment Type Section
	const assignmentID = assignment.AssignmentType;

	// Get the first letter of the assignment type
	id = id + assignmentID.charAt(0);
	id = id + "-";

	// ClassID section
	const groupID = assignment.GroupName;

	// split the group name into words up until the first -
	const groupSplit = groupID.split("-");
	const groupName = groupSplit[0];
	const groupWords = groupName.split(/[. ]/gm);

	// remove articles like "of", "the" and "and"
	const articles = ["of", "the", "and", "a", "an"];
	const filteredWords = groupWords.filter((word) => !articles.includes(word));

	// add the first letter of each word to the id
	filteredWords.map((word: string) => {
		id = id + word.charAt(0).toLocaleUpperCase();
	});

	// Assignment Period Section
	const periodID = groupSplit[1].trim();
	id = id + "-" + periodID;

	// attached the assignment id that CORE assignes to keep it unique
	id = id + "-" + assignment.AssignmentId;

	return id;
}

process.stdin.resume();

process.on("exit", (code) => {
	tokenGrabber.destroy();
	logger.info("Token Grabber Destroyed");
	listener.close();
	logger.info("Listener Closed");
	logger.info(`Flushing logs and exiting with code ${code}...`);
	logger.flush();
});

process.on("SIGINT", async () => {
	logger.info("Shutdown signal received, closing connections and exiting");
	process.exit(0);
});

process.on("SIGTERM", async () => {
	logger.info("Termination signal received, closing connections and exiting");
	process.exit(0);
});

process.on("unhandledRejection", async (reason, promise) => {
	logger.fatal("Unhandled Rejection at:", promise, "reason:", reason);
	process.exit(1);
});

process.on("uncaughtException", async (error) => {
	logger.fatal("Uncaught Exception:", error);
	process.exit(1);
});

// export * from every file
export * from "./structures/scrape.js";
export * from "./structures/calendar.js";
export * from "./types/assignment.js";
export * from "./types/calendar.js";
export * from "./types/missing.js";
export * from "./types/schedule.js";
