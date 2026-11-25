const notices = {
  "en-US": {
    "invite-only": "NationsBot is currently invite only. I’ll join this game once a player here is authorized to play with me.",
    "capacity": "NationsBot is at its game limit. I’ll join this game once I have room.",
    "unavailable": "NationsBot is currently unavailable for this player count. I’ll join if it becomes available.",
    "invalid": "NationsBot beta challenges are for two players. Please invite me to a 1v1 game.",
    "active": "You already have a NationsBot challenge. I’ll join this game once your current challenge ends.",
    "opponent-active": "We already have a 1v1 game in progress. I’ll accept this invitation once we finish our current game.",
    "pending": "Another NationsBot challenge is being created for you. I’ll join this game once I’m available to play you again.",
    "limit": "You’ve reached the limit of five NationsBot challenges today. I’ll join once the limit resets at midnight UTC and you can start a new challenge.",
  },
  "sv-SE": {
    "invite-only": "NationsBot spelar just nu bara med godkända spelare. Jag går med när någon i partiet har fått tillgång.",
    "capacity": "NationsBot har nått sin gräns för samtidiga partier. Jag går med så snart jag har plats.",
    "unavailable": "NationsBot kan för närvarande inte spela med det här spelarantalet. Jag går med om det blir tillgängligt.",
    "invalid": "NationsBots betautmaningar är för två spelare. Bjud gärna in mig till ett tvåspelarparti.",
    "active": "Du har redan en pågående utmaning med NationsBot. Jag går med när din nuvarande utmaning är klar.",
    "opponent-active": "Vi har redan ett tvåspelarparti igång. Jag accepterar inbjudan när vårt pågående parti är klart.",
    "pending": "En annan NationsBot-utmaning håller på att skapas åt dig. Jag går med när jag kan spela mot dig igen.",
    "limit": "Du har nått dagens gräns på fem NationsBot-utmaningar. Jag går med när gränsen återställs vid midnatt UTC och du kan starta en ny utmaning.",
  },
  "de": {
    "invite-only": "NationsBot spielt derzeit nur mit freigeschalteten Personen. Ich trete bei, sobald jemand in dieser Partie freigeschaltet ist.",
    "capacity": "NationsBot hat die Höchstzahl gleichzeitiger Partien erreicht. Ich trete bei, sobald ein Platz frei ist.",
    "unavailable": "NationsBot ist für diese Spielerzahl derzeit nicht verfügbar. Ich trete bei, sobald sie verfügbar ist.",
    "invalid": "NationsBot-Beta-Herausforderungen sind für zwei Personen. Lade mich bitte zu einer Zweierpartie ein.",
    "active": "Du hast bereits eine laufende NationsBot-Herausforderung. Ich trete bei, sobald sie beendet ist.",
    "opponent-active": "Wir spielen bereits eine Zweierpartie. Ich nehme diese Einladung an, sobald unsere aktuelle Partie beendet ist.",
    "pending": "Für dich wird gerade eine andere NationsBot-Herausforderung erstellt. Ich trete bei, sobald ich wieder gegen dich spielen kann.",
    "limit": "Du hast das Tageslimit von fünf NationsBot-Herausforderungen erreicht. Ich trete bei, wenn das Limit um Mitternacht UTC zurückgesetzt wird und du wieder eine Herausforderung starten kannst.",
  },
  "fr": {
    "invite-only": "NationsBot joue actuellement sur invitation réservée aux joueurs autorisés. Je rejoindrai la partie dès qu’un de ses joueurs sera autorisé.",
    "capacity": "NationsBot a atteint sa limite de parties simultanées. Je rejoindrai cette partie dès qu’une place se libérera.",
    "unavailable": "NationsBot est actuellement indisponible pour ce nombre de joueurs. Je rejoindrai la partie si ce format devient disponible.",
    "invalid": "Les défis bêta de NationsBot se jouent à deux. Invite-moi à une partie à deux joueurs.",
    "active": "Tu as déjà un défi NationsBot en cours. Je rejoindrai cette partie dès que ton défi actuel sera terminé.",
    "opponent-active": "Nous avons déjà une partie à deux en cours. J’accepterai cette invitation dès que nous aurons terminé notre partie actuelle.",
    "pending": "Un autre défi NationsBot est en cours de création pour toi. Je rejoindrai cette partie dès que je pourrai de nouveau jouer contre toi.",
    "limit": "Tu as atteint la limite de cinq défis NationsBot par jour. Je rejoindrai la partie après la réinitialisation à minuit UTC, dès que tu pourras lancer un nouveau défi.",
  },
  "es-ES": {
    "invite-only": "NationsBot solo juega con jugadores autorizados por el momento. Me uniré cuando alguno de esta partida tenga acceso.",
    "capacity": "NationsBot ha alcanzado el límite de partidas simultáneas. Me uniré en cuanto tenga sitio.",
    "unavailable": "NationsBot no está disponible para este número de jugadores por ahora. Me uniré si se habilita este formato.",
    "invalid": "Los desafíos beta de NationsBot son para dos jugadores. Invítame a una partida de dos.",
    "active": "Ya tienes un desafío de NationsBot en curso. Me uniré en cuanto termine ese desafío.",
    "opponent-active": "Ya tenemos una partida de dos en curso. Aceptaré esta invitación en cuanto termine nuestra partida actual.",
    "pending": "Se está creando otro desafío de NationsBot para ti. Me uniré en cuanto pueda volver a jugar contigo.",
    "limit": "Has alcanzado el límite de cinco desafíos diarios de NationsBot. Me uniré tras el reinicio a medianoche UTC, cuando puedas iniciar otro desafío.",
  },
  "zh-CN": {
    "invite-only": "NationsBot 目前仅与获准的玩家对局。等这局有玩家获得权限后，我就会加入。",
    "capacity": "NationsBot 的同时对局数已达上限。有空位后我就会加入。",
    "unavailable": "NationsBot 目前不支持这个玩家人数。如果开放该人数，我就会加入。",
    "invalid": "NationsBot 的测试挑战仅支持两人对局。请邀请我参加一对一对局。",
    "active": "你已经有一场 NationsBot 挑战正在进行。等当前挑战结束后，我就会加入这局。",
    "opponent-active": "我们已经有一场一对一对局正在进行。等当前对局结束后，我就会接受这个邀请。",
    "pending": "系统正在为你创建另一场 NationsBot 挑战。等我能再次与你对局时，我就会加入。",
    "limit": "你已达到每天五场 NationsBot 挑战的上限。等到 UTC 午夜额度重置、你可以开始新挑战后，我就会加入。",
  },
};

export function invitationNotice(reason, language) {
  const selected = Object.hasOwn(notices, language) ? notices[language] : notices['en-US'];
  return { message: selected[reason], previousMessages: Object.values(notices).map(locale => locale[reason]) };
}
