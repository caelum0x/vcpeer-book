/**
 * VCPeer Book embeddable booking widget (item 8).
 * Usage: <div data-vcpeer-book data-key="vcbw_..." data-username="admin"
 *             data-event="30min"></div>
 *        <script src="https://book.vcpeer.com/widget.js" defer></script>
 *
 * Renders a lightweight slot picker and posts a booking directly from the
 * host page — the visitor never leaves it. Uses a "widget"-scoped API key
 * (platform.api_keys.scope = 'widget'), which is restricted server-side to
 * GET /v1/slots + POST /v1/bookings only and is safe to expose in page
 * source, the same trust model as a Stripe publishable key.
 */
(function () {
  "use strict";

  var API_BASE = (function () {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src && scripts[i].src.indexOf("/widget.js") !== -1) {
        var u = new URL(scripts[i].src);
        return u.origin;
      }
    }
    return "https://book.vcpeer.com";
  })();

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      e.appendChild(c);
    });
    return e;
  }

  function fetchSlots(key, username, eventSlug) {
    var start = new Date();
    var end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    var url =
      API_BASE +
      "/v1/slots?username=" +
      encodeURIComponent(username) +
      "&eventTypeSlug=" +
      encodeURIComponent(eventSlug) +
      "&startTime=" +
      encodeURIComponent(start.toISOString()) +
      "&endTime=" +
      encodeURIComponent(end.toISOString());
    return fetch(url, { headers: { authorization: "Bearer " + key } }).then(function (r) {
      return r.json();
    });
  }

  function renderWidget(container) {
    var key = container.getAttribute("data-key");
    var username = container.getAttribute("data-username");
    var eventSlug = container.getAttribute("data-event");
    if (!key || !username || !eventSlug) {
      console.error("[vcpeer-book widget] data-key, data-username, data-event are all required");
      return;
    }

    container.innerHTML = "";
    container.className = (container.className || "") + " vcpeer-book-widget";
    var status = el("div", { class: "vcpeer-book-widget__status", text: "Loading available times…" });
    container.appendChild(status);

    fetchSlots(key, username, eventSlug)
      .then(function (json) {
        if (json.error) throw new Error(json.error);
        var slotsByDay = json.data.slots || {};
        var days = Object.keys(slotsByDay).filter(function (d) {
          return slotsByDay[d] && slotsByDay[d].length;
        });
        container.innerHTML = "";
        if (!days.length) {
          container.appendChild(el("div", { class: "vcpeer-book-widget__status", text: "No times available right now — check back soon." }));
          return;
        }
        var list = el("div", { class: "vcpeer-book-widget__slots" });
        days.slice(0, 3).forEach(function (day) {
          var dayHeader = el("div", { class: "vcpeer-book-widget__day", text: day });
          list.appendChild(dayHeader);
          slotsByDay[day].slice(0, 6).forEach(function (slot) {
            var t = new Date(slot.time);
            var btn = el("button", {
              type: "button",
              class: "vcpeer-book-widget__slot",
              text: t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            });
            btn.addEventListener("click", function () {
              showBookingForm(container, key, username, eventSlug, slot.time);
            });
            list.appendChild(btn);
          });
        });
        container.appendChild(list);
      })
      .catch(function (err) {
        container.innerHTML = "";
        container.appendChild(el("div", { class: "vcpeer-book-widget__status", text: "Could not load times: " + err.message }));
      });
  }

  function showBookingForm(container, key, username, eventSlug, isoTime) {
    container.innerHTML = "";
    var nameInput = el("input", { type: "text", placeholder: "Your name", class: "vcpeer-book-widget__input" });
    var emailInput = el("input", { type: "email", placeholder: "Your email", class: "vcpeer-book-widget__input" });
    var submit = el("button", { type: "button", class: "vcpeer-book-widget__confirm", text: "Confirm →" });
    var status = el("div", { class: "vcpeer-book-widget__status" });

    submit.addEventListener("click", function () {
      if (!nameInput.value || !emailInput.value) {
        status.textContent = "Name and email are required.";
        return;
      }
      status.textContent = "Booking…";
      fetch(API_BASE + "/v1/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({
          username: username,
          eventTypeSlug: eventSlug,
          start: isoTime,
          name: nameInput.value,
          email: emailInput.value,
        }),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (json) {
          if (json.error) throw new Error(json.error);
          container.innerHTML = "";
          container.appendChild(el("div", { class: "vcpeer-book-widget__status", text: "Booked! Check your email for the call link." }));
        })
        .catch(function (err) {
          status.textContent = "Could not book: " + err.message;
        });
    });

    container.appendChild(el("div", { class: "vcpeer-book-widget__form" }, [nameInput, emailInput, submit, status]));
  }

  function init() {
    var nodes = document.querySelectorAll("[data-vcpeer-book]");
    for (var i = 0; i < nodes.length; i++) renderWidget(nodes[i]);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
