import { Type } from "@sinclair/typebox";
import { Api } from "telegram";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface GetUniqueGiftParams {
  slug: string;
}

export const telegramGetUniqueGiftTool: Tool = {
  name: "telegram_get_unique_gift",
  description:
    "Look up a unique collectible NFT gift by its slug (from t.me/nft/<slug>). Returns full NFT details including owner, attributes, price, and availability.",
  category: "data-bearing",
  parameters: Type.Object({
    slug: Type.String({
      description: "NFT slug from the t.me/nft/<slug> URL",
    }),
  }),
};

export const telegramGetUniqueGiftExecutor: ToolExecutor<GetUniqueGiftParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const { slug } = params;
    const gramJsClient = context.bridge.getClient().getClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS API response is untyped
    const result: any = await gramJsClient.invoke(new Api.payments.GetUniqueStarGift({ slug }));

    const gift = result.gift;

    const users = result.users || [];
    const ownerUserId = gift.ownerId?.userId?.toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS API response is untyped
    const ownerUser = users.find((u: any) => u.id?.toString() === ownerUserId);

    log.info(`get_unique_gift: slug=${slug} title=${gift.title}`);

    return {
      success: true,
      data: {
        id: gift.id?.toString(),
        giftId: gift.giftId?.toString(),
        slug: gift.slug,
        title: gift.title,
        num: gift.num,
        owner: {
          id: ownerUserId,
          name: gift.ownerName || undefined,
          address: gift.ownerAddress || undefined,
          username: ownerUser?.username || undefined,
          firstName: ownerUser?.firstName || undefined,
          lastName: ownerUser?.lastName || undefined,
        },
        giftAddress: gift.giftAddress || undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS API response is untyped
        attributes: (gift.attributes || []).map((attr: any) => ({
          type: attr.className?.replace("StarGiftAttribute", "").toLowerCase(),
          name: attr.name,
          rarityPercent: attr.rarityPermille ? attr.rarityPermille / 10 : undefined,
        })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS API response is untyped
        resellPrices: (gift.resellAmount || []).map((a: any) => ({
          amount: a.amount?.toString(),
          isTon: !!a.ton,
        })),
        availability: gift.availability
          ? {
              total: gift.availability.total,
              remaining: gift.availability.remaining,
            }
          : undefined,
        nftLink: `t.me/nft/${gift.slug}`,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS API response is untyped
  } catch (error: any) {
    if (error.errorMessage === "STARGIFT_SLUG_INVALID") {
      return {
        success: false,
        error: `Invalid NFT slug "${params.slug}". Check the slug from t.me/nft/<slug>.`,
      };
    }
    log.error({ err: error }, "Error getting unique gift");
    return { success: false, error: getErrorMessage(error) };
  }
};
