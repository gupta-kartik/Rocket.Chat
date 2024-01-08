import { Omnichannel } from '@rocket.chat/core-services';
import type { ILivechatInquiryRecord, ILivechatVisitor, IMessage, IOmnichannelRoom, SelectedAgent } from '@rocket.chat/core-typings';
import { Logger } from '@rocket.chat/logger';
import { LivechatInquiry, LivechatRooms, Users } from '@rocket.chat/models';
import { Match, check } from 'meteor/check';
import { Meteor } from 'meteor/meteor';

import { callbacks } from '../../../../lib/callbacks';
import { checkServiceStatus, createLivechatRoom, createLivechatInquiry } from './Helper';
import { RoutingManager } from './RoutingManager';

const logger = new Logger('QueueManager');

export const saveQueueInquiry = async (inquiry: ILivechatInquiryRecord) => {
	await LivechatInquiry.queueInquiry(inquiry._id);
	await callbacks.run('livechat.afterInquiryQueued', inquiry);
};

export const queueInquiry = async (inquiry: ILivechatInquiryRecord, defaultAgent?: SelectedAgent) => {
	const inquiryAgent = await RoutingManager.delegateAgent(defaultAgent, inquiry);
	logger.debug({
		msg: 'Routing inquiry',
		inquiryId: inquiry._id,
		inquiryAgent,
	});

	const dbInquiry = await callbacks.run('livechat.beforeRouteChat', inquiry, inquiryAgent);
	const room = await LivechatRooms.findOneById(inquiry.rid, { projection: { v: 1 } });
	if (!room || !(await Omnichannel.isWithinMACLimit(room))) {
		logger.error({ msg: 'MAC limit reached, not routing inquiry', inquiry });
		// We'll queue these inquiries so when new license is applied, they just start rolling again
		// Minimizing disruption
		await saveQueueInquiry(inquiry);
		return;
	}

	if (dbInquiry.status === 'ready') {
		logger.debug(`Inquiry with id ${inquiry._id} is ready. Delegating to agent ${inquiryAgent?.username}`);
		return RoutingManager.delegateInquiry(dbInquiry, inquiryAgent);
	}
};

type queueManager = {
	requestRoom: (params: {
		guest: ILivechatVisitor;
		message: Pick<IMessage, 'rid' | 'msg'>;
		roomInfo: {
			source?: IOmnichannelRoom['source'];
			[key: string]: unknown;
		};
		agent?: SelectedAgent;
		extraData?: Record<string, unknown>;
	}) => Promise<IOmnichannelRoom>;
	unarchiveRoom: (archivedRoom?: IOmnichannelRoom) => Promise<IOmnichannelRoom>;
};

export const QueueManager: queueManager = {
	async requestRoom({ guest, message, roomInfo, agent, extraData }) {
		logger.debug(`Requesting a room for guest ${guest._id}`);
		check(
			message,
			Match.ObjectIncluding({
				rid: String,
			}),
		);
		check(
			guest,
			Match.ObjectIncluding({
				_id: String,
				username: String,
				status: Match.Maybe(String),
				department: Match.Maybe(String),
				name: Match.Maybe(String),
				activity: Match.Maybe([String]),
			}),
		);

		if (!(await checkServiceStatus({ guest, agent }))) {
			throw new Meteor.Error('no-agent-online', 'Sorry, no online agents');
		}

		const { rid } = message;
		const name = (roomInfo?.fname as string) || guest.name || guest.username;

		const room = await createLivechatRoom(rid, name, guest, roomInfo, extraData);
		if (!room) {
			throw new Error('room-not-found');
		}

		const inquiry = await LivechatInquiry.findOneById(
			await createLivechatInquiry({
				rid,
				name,
				guest,
				message,
				extraData: { ...extraData, source: roomInfo.source },
			}),
		);
		if (!inquiry) {
			throw new Error('inquiry-not-found');
		}

		logger.debug({
			msg: 'New room created',
			rid,
			inquiryId: inquiry._id,
		});

		await LivechatRooms.updateRoomCount();

		await queueInquiry(inquiry, agent);
		logger.debug({
			msg: 'Inquiry queued',
			inquiryId: inquiry._id,
		});

		const newRoom = await LivechatRooms.findOneById(rid);
		if (!newRoom) {
			throw new Error('room-not-found');
		}

		return newRoom;
	},

	async unarchiveRoom(archivedRoom) {
		if (!archivedRoom) {
			throw new Error('no-room-to-unarchive');
		}

		const { _id: rid, open, closedAt, fname: name, servedBy, v, departmentId: department, lastMessage: message, source } = archivedRoom;

		if (!rid || !closedAt || !!open) {
			return archivedRoom;
		}

		logger.debug(`Attempting to unarchive room with id ${rid}`);

		const oldInquiry = await LivechatInquiry.findOneByRoomId<Pick<ILivechatInquiryRecord, '_id'>>(rid, { projection: { _id: 1 } });
		if (oldInquiry) {
			logger.debug(`Removing old inquiry (${oldInquiry._id}) for room ${rid}`);
			await LivechatInquiry.removeByRoomId(rid);
		}

		const guest = {
			...v,
			...(department && { department }),
		};

		let defaultAgent: SelectedAgent | undefined;
		if (servedBy?.username && (await Users.findOneOnlineAgentByUserList(servedBy.username))) {
			defaultAgent = { agentId: servedBy._id, username: servedBy.username };
		}

		await LivechatRooms.unarchiveOneById(rid);
		const room = await LivechatRooms.findOneById(rid);
		if (!room) {
			throw new Error('room-not-found');
		}
		const inquiry = await LivechatInquiry.findOneById(
			await createLivechatInquiry({ rid, name: name || guest.username, guest, message, extraData: { source } }),
		);
		if (!inquiry) {
			throw new Error('inquiry-not-found');
		}

		await queueInquiry(inquiry, defaultAgent);
		logger.debug(`Inquiry ${inquiry._id} queued`);

		return room;
	},
};
