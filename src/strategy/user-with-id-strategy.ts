import { Strategy } from '../strategy';

export default class UserWithIdStrategy extends Strategy {
    constructor () {
        super('userWithId');
    }

    isEnabled (parameters, context) {
        const userIdList = parameters.userIds.split(/\s*,\s*/);
        return userIdList.includes(context.userId);
    }
}