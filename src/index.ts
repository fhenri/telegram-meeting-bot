import { Bot, Context, session, SessionFlavor, webhookCallback } from 'grammy';
import { type Conversation, type ConversationFlavor, conversations, createConversation } from '@ponomarevlad/grammyjs-conversations';
import { freeStorage } from '@grammyjs/storage-free';
import { parse, isAfter } from 'date-fns';
interface SessionData {
	message: string;
}

type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

type Room = {
	id: string;
	name: string;
	capacity: number;
};

interface RoomElements {
	rooms: Room[];
}

interface EventMessage {
	event: { message: string };
}
export interface Env {
	BOT_INFO: string;
	BOT_TOKEN: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const bot = new Bot<MyContext>(env.BOT_TOKEN, {
			botInfo: JSON.parse(env.BOT_INFO),
		});

		async function meeting(conversation: MyConversation, ctx: MyContext) {
			await ctx.reply('Enter the Title for the Meeting [Meeting Title] ?');
			const meetingTitleCtx = await conversation.wait();

			const meetingDate = await getMeetingDate(conversation, ctx);

			await ctx.reply('Enter Start Time (format HH:mm)');
			const startTimeCtx = await conversation.wait();

			await ctx.reply('Enter End Time (format HH:mm)');
			const endTimeCtx = await conversation.wait();

			await ctx.reply('Enter Participants (1 participant on each line)');
			const participantsCtx = await conversation.wait();
			const participantsList: string[] = participantsCtx.message?.text?.split('\n') || [ctx.from?.username || ''];
			const participantNb = participantsList.length || 1;

			const roomList = await conversation.external(
				async () => await getMeetingRoom(
					conversation,
					ctx,
					participantNb.toString(),
					meetingDate.toISOString().split('T')[0],
					startTimeCtx.message?.text || '',
					endTimeCtx.message?.text || ''
				)
			);

			const selectedRoomId = await getRoomForMeeting(
				conversation, ctx,
				roomList
			)

			if (!selectedRoomId) {
				await ctx.reply("no room available for this time for this number of people");
				return;
			}

			const bookingMessage = await conversation.external(
				async () => await bookMeetingRoom(
					conversation,
					ctx,
					meetingTitleCtx.message?.text,
					meetingDate.toISOString().split('T')[0],
					startTimeCtx.message?.text || '',
					endTimeCtx.message?.text || '',
					participantsList,
					selectedRoomId
				)
			);

			await ctx.reply(bookingMessage);
		}

		bot.use(
			session({
				storage: freeStorage<SessionData>(bot.token),
				initial: () => ({ message: '' }),
			})
		);
		bot.use(conversations());

		// Always exit any conversation upon /cancel
		bot.command("cancel", async (ctx) => {
			await ctx.conversation.exit();
			await ctx.reply("Leaving.");
		});

		bot.use(createConversation(meeting));
		bot.command('create', async (ctx) => {
			await ctx.conversation.enter('meeting');
		});

		bot.on('message', async (ctx) => {
			const message = ctx.msg.text;
			await ctx.reply(`do /create to create a new meeting`);
		});

		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
};

async function getMeetingDate(conversation: MyConversation, ctx: MyContext): Promise<Date> {
	let meetingDate: Date | null = null;

	do {
		await ctx.reply('Enter the Meeting Date (format DD/MM/YYYY)');
		const meetingDateCtx = await conversation.wait();

		if (!meetingDateCtx || !meetingDateCtx.message) {
			await ctx.reply('Error: Invalid meeting date.');
			continue;
		}

		meetingDate = parse(meetingDateCtx.message.text!, 'dd/MM/yyyy', new Date());

		// Check if the parsed date is valid
		if (isNaN(meetingDate.getTime())) {
			await ctx.reply('Error: Invalid date format. Please use DD/MM/YYYY.');
			meetingDate = null;
			continue;
		}

		// Check if the date is in the past
		const today = await conversation.now();
		if (isAfter(today, meetingDate)) {
			await ctx.reply('Error: Meeting date cannot be in the past.');
			meetingDate = null;
		}
	} while (meetingDate === null);

	return meetingDate!;
}

async function getMeetingRoom(
	conversation: MyConversation,
	ctx: MyContext,
	participantNb: string,
	meetingDate: string,
	startTime: string,
	endTime: string
) {
	// call to get the list of available rooms
	const params = new URLSearchParams({
		capacity: participantNb,
		date: meetingDate,
		timeFrom: startTime,
		timeTo: endTime,
	});

	const responseSchedule = await fetch(`https://booking-room.cloud06.io/api/schedule?${params}`);

	if (responseSchedule.status !== 200) {
		await ctx.reply(`Error when getting available rooms: ${responseSchedule.statusText}`);
		return;
	}

	const data = (await responseSchedule.json()) as RoomElements;
	return data;
}

async function bookMeetingRoom(
	conversation: MyConversation,
	ctx: MyContext,
	meetingTitle: string | undefined,
	meetingDate: string,
	startTime: string,
	endTime: string,
	participantList: string[],
	selectedRoomId: string | undefined
): Promise<string> {
	const meetingData = {
		title: meetingTitle,
		date: meetingDate,
		timeFrom: startTime,
		timeTo: endTime,
		guests: participantList,
		roomId: selectedRoomId,
	};

	const responseMeeting = await fetch('https://booking-room.cloud06.io/api/schedule', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(meetingData),
	});

	if (responseMeeting.status !== 200) {
		return `Error when creating event: ${responseMeeting.statusText}`;
	}

	const resultMeeting: EventMessage = await responseMeeting.json();
	return resultMeeting.event.message;
}

async function getRoomForMeeting (
	conversation: MyConversation,
	ctx: MyContext,
	roomList: RoomElements | undefined
): Promise<string | undefined> {

	if (roomList && roomList.rooms && roomList.rooms.length > 0) {
		let message = '<b>Room Selection</b>\n\n';
		message += "<pre><code class='language-html'>\n";
		message += 'ID  | Room Name         | Capacity\n';
		message += '----+-------------------+----------\n';
		roomList.rooms.forEach((room: Room, index: number) => {
			message += `${index + 1}  | ${room.name.padEnd(18)} | ${room.capacity}\n`;
		});
		message += '</code></pre>\n\n';
		message += 'Select a room by its ID number.';

		// Store mapping for later use
		const roomIdMap: { [key: number]: string } =
			roomList.rooms.reduce((acc, room, index) => {
				acc[index + 1] = room.id;
				return acc;
			}, {} as { [key: number]: string });

		await ctx.reply(message, { parse_mode: 'HTML' });
		const roomSelectionCtx = await conversation.wait();
		const selectedRoom =
			parseInt(roomSelectionCtx?.message?.text || '', 10);

		return roomIdMap[selectedRoom];
	} else {
		return;
	}

}
