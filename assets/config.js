// Everything that changes when the shop goes live lives here.
window.OP_CONFIG = {
  // Address shown for sales and support. Empty: the address is hidden and the
  // contact form is the only way in.
  email: "",
  // Web3Forms access key. Public by design: it only lets a form send to the
  // address registered with Web3Forms.
  web3forms: "22a78de0-9072-4289-8312-3bb820231254",
  github: "https://github.com/OpenPronounce/OpenPronounce",
  pypi: "https://pypi.org/project/openpronounce/",
  // Checkout links of the payment provider, one per plan. Empty: the order is
  // sent through the contact form and a payment link is sent back by email.
  checkout: {
    small: "https://buy.polar.sh/polar_cl_3YG2yfh0Gi0rrt4Sv2JQAnvqqEv4iz7OXgyhc0x1maa",
    business: "https://buy.polar.sh/polar_cl_5YB45zS0fNXTwbszcxGheRNWDt83tiXbDyOPQ0608Zu"
  }
};
